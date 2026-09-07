const admin = require('firebase-admin');

const parseServiceAccount = () => {
    const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!rawJson) return null;

    try {
        return JSON.parse(rawJson);
    } catch (error) {
        console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
        return null;
    }
};

const getFirebaseAdmin = () => {
    if (admin.apps.length) return admin;

    const serviceAccount = parseServiceAccount();
    if (!serviceAccount) return null;

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });

    return admin;
};

module.exports = { getFirebaseAdmin };
