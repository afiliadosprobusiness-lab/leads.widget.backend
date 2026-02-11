import admin from "firebase-admin";

let initialized = false;

export function getFirebaseAdmin() {
  if (initialized && admin.apps.length) return admin;

  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountRaw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountRaw);
  } catch (error) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT JSON: ${error.message}`);
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  initialized = true;
  return admin;
}

export function getFirestore() {
  return getFirebaseAdmin().firestore();
}
