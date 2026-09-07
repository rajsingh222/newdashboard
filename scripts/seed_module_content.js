const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Project = require('../models/Project');
const Module = require('../models/Module');
const ModuleContent = require('../models/ModuleContent');

async function seed() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB for seeding structural module contents...');

        // Find the project named "Project" (Rajesh's project)
        const project = await Project.findOne({ projectName: 'Project' });
        if (!project) {
            console.error('Project "Project" not found!');
            process.exit(1);
        }
        console.log(`Found project: ${project.projectName} (${project._id})`);

        // Find module IDs
        const modules = await Module.find({
            moduleName: { $in: ['Design Proof Check', 'Load Testing', 'Non-Destructive Evaluation'] }
        });

        const designModule = modules.find(m => m.moduleName === 'Design Proof Check');
        const loadModule = modules.find(m => m.moduleName === 'Load Testing');
        const ndtModule = modules.find(m => m.moduleName === 'Non-Destructive Evaluation');

        if (!designModule || !loadModule || !ndtModule) {
            console.error('Core modules not found in database!');
            process.exit(1);
        }

        // Data for Design Proof Check
        const designData = {
            project: project._id,
            module: designModule._id,
            details: "Comprehensive design validation and proof check for Rajesh's Steel Girder Bridge. Calculations have been verified against Indian Road Congress (IRC:112-2020) and Bureau of Indian Standards (IS 800:2007). Finite Element Analysis (FEA) model was checked for ultimate limit states (ULS) and serviceability limit states (SLS) under Class 70R loading envelopes. The design is classified as structurally safe and optimal.",
            keyValues: [
                { key: "Demand Capacity Ratio", value: "0.72" },
                { key: "Maximum Utilization", value: "72.4%" },
                { key: "Factor of Safety", value: "1.65" },
                { key: "Maximum Deflection", value: "6.12 mm" },
                { key: "Maximum Stress", value: "18.5 MPa" },
                { key: "Critical Member", value: "Steel Girder SG-03" },
                { key: "Overall Design Status", value: "PASS" },
                { key: "Design Standard", value: "IRC:112-2020" },
                { key: "Concrete Grade", value: "M40" },
                { key: "Steel Grade", value: "Fe500" },
                { key: "Consultant Name", value: "IIT Delhi Bridge Design Cell" }
            ],
            images: ["/uploads/modules/images/1772261322692-297021228.jpg"],
            graphs: [{
                title: "Bending Moment Envelope",
                description: "Design moment envelope vs structural bending capacity across Span 3.",
                imagePath: "/uploads/modules/graphs/1772268947502-806687944.jpeg",
                uploadedAt: new Date()
            }],
            reports: [{
                name: "Design Calculation Sheets & Proof Certificate.pdf",
                filePath: "/uploads/modules/reports/1772261329798-72756687.pdf",
                uploadedAt: new Date()
            }]
        };

        // Data for Load Testing
        const loadData = {
            project: project._id,
            module: loadModule._id,
            details: "Full-scale load testing conducted on the Span 3 girder. In accordance with IRC SP:51 guidelines, static truck loadings up to 45 Tonnes were placed at critical locations to register maximum span deflection. Dial gauge displacement sensors and fiber optic strain sensors were installed. Recovery ratios exceed 85%, confirming the bridge operates safely in its elastic regime.",
            keyValues: [
                { key: "Applied Load", value: "45.0 Tonnes" },
                { key: "Maximum Deflection", value: "4.82 mm" },
                { key: "Residual Deflection", value: "0.60 mm" },
                { key: "Maximum Strain", value: "120 με" },
                { key: "Maximum Stress", value: "24.5 MPa" },
                { key: "Elastic Recovery %", value: "87.5%" },
                { key: "Natural Frequency", value: "3.84 Hz" },
                { key: "Overall Test Result", value: "PASS" },
                { key: "Structure Type", value: "Pre-stressed Concrete Box Girder" },
                { key: "Load Testing Standard", value: "IRC SP:51-2015" }
            ],
            images: ["/uploads/modules/images/1772261356103-649432656.jpg"],
            graphs: [{
                title: "Load vs Mid-Span Deflection",
                description: "Displacement path during incremental truck load testing, indicating clear elastic recovery.",
                imagePath: "/uploads/modules/graphs/1772268947502-806687944.jpeg",
                uploadedAt: new Date()
            }],
            reports: [{
                name: "Bridge Diagnostic Load Test Performance Report.pdf",
                filePath: "/uploads/modules/reports/1772261363703-627557645.pdf",
                uploadedAt: new Date()
            }]
        };

        // Data for NDT
        const ndtData = {
            project: project._id,
            module: ndtModule._id,
            details: "NDT (Non-Destructive Testing) field survey completed for Abutments A1 and Piers P2/P3. Rebound hammer index, Ultrasonic Pulse Velocity (UPV), and half-cell potential mapping were carried out. Cover meter scanning was performed to map reinforcement rebar spacing. Results indicate high-quality concrete consolidation with low corrosion risks.",
            keyValues: [
                { key: "Overall Structural Condition", value: "Good" },
                { key: "Concrete Quality", value: "Good (3.85 km/s)" },
                { key: "Corrosion Risk", value: "Low (< 10%)" },
                { key: "Number of Defects", value: "2 Minor Superficial Cracks" },
                { key: "Critical Elements", value: "None" },
                { key: "Remaining Service Life", value: "45 Years" },
                { key: "Health Score", value: "88/100" },
                { key: "NDT Standard", value: "IS 13311 / ASTM C876" },
                { key: "Concrete Grade", value: "M35" },
                { key: "Rebar Cover Thickness", value: "35 mm" }
            ],
            images: ["/uploads/modules/images/1772261380377-829063871.jpg"],
            graphs: [{
                title: "Ultrasonic Pulse Velocity Contour",
                description: "Contour map of pulse velocity across Pier P2 surface scan.",
                imagePath: "/uploads/modules/graphs/1772268947502-806687944.jpeg",
                uploadedAt: new Date()
            }],
            reports: [{
                name: "Non-Destructive Test Site Survey & Inspection Report.pdf",
                filePath: "/uploads/modules/reports/1772261383890-313669103.pdf",
                uploadedAt: new Date()
            }]
        };

        // Save/Upsert documents
        await ModuleContent.findOneAndUpdate(
            { project: project._id, module: designModule._id },
            { $set: designData },
            { upsert: true, new: true }
        );
        console.log('Seeded Design Proof Check content.');

        await ModuleContent.findOneAndUpdate(
            { project: project._id, module: loadModule._id },
            { $set: loadData },
            { upsert: true, new: true }
        );
        console.log('Seeded Load Testing content.');

        await ModuleContent.findOneAndUpdate(
            { project: project._id, module: ndtModule._id },
            { $set: ndtData },
            { upsert: true, new: true }
        );
        console.log('Seeded Non-Destructive Evaluation content.');

        console.log('--- SEEDING COMPLETE ---');
    } catch (e) {
        console.error('Seeding error:', e);
    } finally {
        await mongoose.connection.close();
    }
}

seed();
