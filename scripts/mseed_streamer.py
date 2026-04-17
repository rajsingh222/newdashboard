import argparse
import json
import math
import sys
import time

import numpy as np

try:
    from obspy import read as obspy_read
except Exception as exc:
    print(json.dumps({"type": "error", "data": {"message": f"ObsPy import failed: {exc}"}}), flush=True)
    sys.exit(1)


def build_sensor_map(traces):
    traces_sorted = sorted(traces, key=lambda t: t.stats.channel)
    channels_per_sensor = 3
    num_sensors = len(traces_sorted) // channels_per_sensor
    sensors = {}

    for i in range(num_sensors):
        x_tr = traces_sorted[i * channels_per_sensor + 0]
        y_tr = traces_sorted[i * channels_per_sensor + 1]
        z_tr = traces_sorted[i * channels_per_sensor + 2]
        name = f"Sensor_{i + 1}"

        sensors[name] = {
            "X": x_tr.data.astype(np.float64),
            "Y": y_tr.data.astype(np.float64),
            "Z": z_tr.data.astype(np.float64),
            "channelX": str(x_tr.stats.channel),
            "channelY": str(y_tr.stats.channel),
            "channelZ": str(z_tr.stats.channel),
        }

    return sensors


def stream_file(file_path, chunk_duration_sec=0.25, downsample=4, speed=1.0):
    stream = obspy_read(file_path)
    if not stream or not stream.traces:
        print(json.dumps({"type": "error", "data": {"message": "No traces found in MiniSEED"}}), flush=True)
        return 1

    first = stream.traces[0]
    sampling_rate = float(first.stats.sampling_rate)
    npts = int(first.stats.npts)
    start_time = first.stats.starttime
    end_time = first.stats.endtime
    duration_sec = float(end_time - start_time)
    start_epoch = float(start_time.timestamp)

    sensors = build_sensor_map(stream.traces)

    metadata = {
        "filename": file_path.split("/")[-1].split("\\")[-1],
        "sampling_rate": sampling_rate,
        "npts": npts,
        "duration_sec": duration_sec,
        "start_time": str(start_time),
        "end_time": str(end_time),
        "num_sensors": len(sensors),
        "sensor_names": list(sensors.keys()),
    }

    print(json.dumps({"type": "metadata", "data": metadata}), flush=True)

    chunk_samples = max(1, int(sampling_rate * chunk_duration_sec))
    total_chunks = int(math.ceil(npts / chunk_samples))
    t0 = time.time()
    chunk_index = 0

    for start_idx in range(0, npts, chunk_samples):
        end_idx = min(start_idx + chunk_samples, npts)
        ds = max(1, downsample)
        sl = slice(start_idx, end_idx, ds)
        chunk_start_time = start_time + (start_idx / sampling_rate)
        chunk_end_time = start_time + (end_idx / sampling_rate)
        last_sample_idx = max(start_idx, end_idx - 1)
        last_sample_time = start_time + (last_sample_idx / sampling_rate)
        chunk_timestamps = (np.arange(start_idx, end_idx, ds, dtype=np.float64) / sampling_rate + start_epoch).tolist()

        payload_sensors = {}
        for sensor_name, sensor_data in sensors.items():
            payload_sensors[sensor_name] = {
                "X": sensor_data["X"][sl].tolist(),
                "Y": sensor_data["Y"][sl].tolist(),
                "Z": sensor_data["Z"][sl].tolist(),
                "timestamps": chunk_timestamps,
                "channelX": sensor_data["channelX"],
                "channelY": sensor_data["channelY"],
                "channelZ": sensor_data["channelZ"],
            }

        message = {
            "type": "data_chunk",
            "data": {
                "chunk_index": chunk_index,
                "total_chunks": total_chunks,
                "start_sample": start_idx,
                "end_sample": end_idx,
                "total_samples": npts,
                "progress": float(end_idx / npts),
                "elapsed_sec": float(end_idx / sampling_rate),
                "chunk_start_time": str(chunk_start_time),
                "chunk_end_time": str(chunk_end_time),
                "last_sample_time": str(last_sample_time),
                "sensors": payload_sensors,
            },
        }
        print(json.dumps(message), flush=True)

        chunk_index += 1

        expected_time = (end_idx / sampling_rate) / max(0.01, speed)
        actual_time = time.time() - t0
        wait_sec = expected_time - actual_time
        if wait_sec > 0:
            time.sleep(wait_sec)

    print(json.dumps({"type": "stream_end", "data": {"elapsed_sec": float(time.time() - t0)}}), flush=True)
    return 0


def parse_args():
    parser = argparse.ArgumentParser(description="MiniSEED real-time chunk streamer")
    parser.add_argument("file", help="Path to .mseed file")
    parser.add_argument("--chunk-duration", type=float, default=0.25)
    parser.add_argument("--downsample", type=int, default=4)
    parser.add_argument("--speed", type=float, default=1.0)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        code = stream_file(args.file, args.chunk_duration, args.downsample, args.speed)
        sys.exit(code)
    except Exception as exc:
        print(json.dumps({"type": "error", "data": {"message": f"Parser failed: {exc}"}}), flush=True)
        sys.exit(1)
