import express from "express";
import OpenAI from "openai";
import crypto from "node:crypto";
import { getFirebaseAdmin, getFirestore } from "./firebase.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const firestore = getFirestore();
const firebaseAdmin = getFirebaseAdmin();
const SUPERADMIN_EMAILS = new Set([
  "afiliadosprobusiness@gmail.com",
  "superadmin@leadwidget.pe",
  "superadmin2@leadwidget.pe",
]);
const PARTNER_ROLES = new Set(["partner_admin", "partner_staff"]);
const PARTNER_USER_STATUSES = new Set(["active", "invited", "suspended"]);
const PARTNER_STATUSES = new Set(["active", "suspended"]);
const COMMISSION_STATUS = new Set(["pending", "approved", "paid", "void"]);
const PLAN_BASE_AMOUNT_PEN = Object.freeze({
  pro: 30,
  plus: 60,
});
const DEFAULT_IACLOSER_API_URL = "https://ai-call-closer-saas.vercel.app/api/leads/handoff";
const ACQUISITION_STATUSES = new Set(["pending", "approved", "discarded"]);
const ACQUISITION_OPERATION_STATUSES = new Set(["approved", "discarded"]);
const CRM_STAGES = new Set(["new", "contacted", "qualified", "won", "lost"]);
const CRM_MANUAL_SOURCE = "crm_manual";
const MAX_CRM_CONTACTS_LIST_LIMIT = 200;
const CRM_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACQUISITION_SOURCE = "google_places";
const ACQUISITION_CRM_SOURCE = "acquisition_google_places";
const ACQUISITION_GOOGLE_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const ACQUISITION_GOOGLE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.internationalPhoneNumber",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.types",
].join(",");

const corsOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function corsFor(req, res) {
  const origin = req.headers.origin || "";
  const allowAny = corsOrigins.includes("*");
  const allowed = allowAny || (origin && corsOrigins.includes(origin));

  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

app.use((req, res, next) => {
  corsFor(req, res);
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  return next();
});

function clientIpFrom(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function normalizeIpForSignupLimit(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let normalized = raw;
  if (normalized.startsWith("::ffff:")) normalized = normalized.slice(7);

  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  if (normalized.includes(".") && normalized.includes(":")) {
    const parts = normalized.split(":");
    const maybePort = parts[parts.length - 1] || "";
    if (/^\d{1,5}$/.test(maybePort)) {
      normalized = parts.slice(0, -1).join(":");
    }
  }

  return normalized.trim();
}

function hashSignupIp(normalizedIp) {
  return crypto.createHash("sha256").update(normalizedIp).digest("hex");
}

async function acquireSignupIpLock({ uid, clientIp, nowIso }) {
  const normalizedIp = normalizeIpForSignupLimit(clientIp);
  if (!normalizedIp || normalizedIp === "unknown") {
    return { lockRef: null, lockCreated: false, ipHash: null };
  }

  const ipHash = hashSignupIp(normalizedIp);
  const lockRef = firestore.collection("signup_ip_locks").doc(ipHash);
  let lockCreated = false;

  await firestore.runTransaction(async (tx) => {
    const lockSnap = await tx.get(lockRef);
    if (lockSnap.exists) {
      const lockData = lockSnap.data() || {};
      const ownerUid = String(lockData.uid || "").trim();
      if (ownerUid && ownerUid !== uid) {
        const ownerProfileSnap = await tx.get(firestore.collection("profiles").doc(ownerUid));
        if (ownerProfileSnap.exists) {
          const error = new Error("Only one account per IP is allowed");
          error.code = "IP_SIGNUP_LIMIT_REACHED";
          error.httpStatus = 429;
          throw error;
        }
      }

      tx.set(lockRef, {
        uid,
        ip_hash: ipHash,
        last_seen_at: nowIso,
      }, { merge: true });
      return;
    }

    lockCreated = true;
    tx.set(lockRef, {
      uid,
      ip_hash: ipHash,
      created_at: nowIso,
      last_seen_at: nowIso,
    });
  });

  return { lockRef, lockCreated, ipHash };
}

function toDateKey(date) {
  return date.toISOString().split("T")[0];
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDaysIso(value, days = 30) {
  const baseDate = parseIsoDate(value);
  if (!baseDate) return null;
  const nextDate = new Date(baseDate);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate.toISOString();
}

function getWidgetEmbedUrl(req) {
  const explicit = (process.env.WIDGET_EMBED_URL || "").trim();
  if (explicit) return explicit;

  const appUrl = (process.env.PUBLIC_APP_URL || "").trim();
  if (appUrl) return `${appUrl.replace(/\/$/, "")}/widget-embed.js`;

  const referer = req.headers.referer || req.headers.referrer;
  if (typeof referer === "string" && referer) {
    try {
      const u = new URL(referer);
      return `${u.origin}/widget-embed.js`;
    } catch {
      // ignore
    }
  }

  return "https://leads-widget.vercel.app/widget-embed.js";
}

function getPublicFirebaseConfig() {
  return {
    projectId: (process.env.FIREBASE_PUBLIC_PROJECT_ID || "leads-widget").trim(),
    apiKey: (process.env.FIREBASE_PUBLIC_API_KEY || "AIzaSyCXNFoeg1nrYcFHzU9TEKNnDPg1mHU3_tA").trim(),
  };
}

const FACEBOOK_PIXEL_ID_RE = /^\d{5,20}$/;
const TIKTOK_PIXEL_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const GOOGLE_TAG_ID_RE = /^(G-[A-Z0-9]+|AW-\d+|GTM-[A-Z0-9]+|DC-\d+|UA-\d+-\d+)$/;
const MAX_FACEBOOK_PIXEL_ID_LENGTH = 20;
const MAX_TIKTOK_PIXEL_ID_LENGTH = 64;
const MAX_GOOGLE_TAG_ID_LENGTH = 32;

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function getIaCloserApiUrl() {
  return cleanText(process.env.IACLOSER_API_URL || "") || DEFAULT_IACLOSER_API_URL;
}

function getIaCloserApiKey() {
  return cleanText(process.env.IACLOSER_API_KEY || "");
}

function parseEtaSeconds(value, fallback = 60) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) return fallback;
  return Math.round(normalized);
}

function normalizeConsentAnswer(value) {
  return cleanText(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function hasExplicitConsentYes(value) {
  const normalized = normalizeConsentAnswer(value);
  return normalized === "si" || normalized === "yes";
}

function sanitizeHttpUrl(value, { maxLength = 500 } = {}) {
  const normalized = cleanText(value);
  if (!normalized || normalized.length > maxLength) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sanitizePhoneNumber(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return digits;
}

function trimToMaxLength(value, maxLength = 400) {
  const normalized = cleanText(value);
  if (!normalized) return "";
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeComparableText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function parseOptionalMinScore(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed);
}

function normalizeAcquisitionStatus(value, fallback = "pending") {
  const normalized = cleanText(value).toLowerCase();
  return ACQUISITION_STATUSES.has(normalized) ? normalized : fallback;
}

function getGoogleMapsApiKey() {
  return cleanText(process.env.GOOGLE_MAPS_API_KEY || "");
}

function buildAcquisitionProspectDocId(clientId, externalId) {
  const raw = `${cleanText(clientId)}|${cleanText(externalId)}`;
  const hash = crypto.createHash("sha1").update(raw).digest("hex");
  return `acq_${hash}`;
}

function buildAcquisitionTextQuery({ category, city, country }) {
  const base = [cleanText(category), cleanText(city), cleanText(country)].filter(Boolean).join(", ");
  return base.includes(",") ? base : [cleanText(category), "in", cleanText(city), cleanText(country)].filter(Boolean).join(" ");
}

function buildFallbackMapsUrl({ businessName, address, city, country }) {
  const query = [businessName, address, city, country].filter(Boolean).join(" ");
  if (!query) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function extractPlaceAddressComponent(place = {}, acceptedTypes = []) {
  if (!Array.isArray(place.addressComponents)) return "";
  for (const component of place.addressComponents) {
    const componentTypes = Array.isArray(component?.types) ? component.types : [];
    if (acceptedTypes.some((type) => componentTypes.includes(type))) {
      return trimToMaxLength(component.longText || component.shortText || "", 180);
    }
  }
  return "";
}

function sanitizeReadablePhone(value) {
  const raw = trimToMaxLength(value, 60);
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 8 || digits.length > 18) return "";
  return raw;
}

function normalizeAcquisitionCategory(place = {}, fallbackCategory = "") {
  return trimToMaxLength(
    place?.primaryTypeDisplayName?.text
      || place?.primaryType
      || fallbackCategory,
    160,
  );
}

function hasCommercialCategorySignal(category, placeTypes = []) {
  const normalizedCategory = normalizeComparableText(category);
  const normalizedTypes = Array.isArray(placeTypes)
    ? placeTypes.map((item) => normalizeComparableText(item))
    : [];
  const signals = [
    "dent", "clinic", "spa", "esthetic", "law", "legal", "real_estate",
    "inmobili", "car_repair", "auto", "restaurant", "doctor", "medic",
    "salon", "gym", "agency", "marketing", "account", "hotel",
  ];
  return signals.some((signal) =>
    normalizedCategory.includes(signal) || normalizedTypes.some((type) => type.includes(signal)));
}

function calculateCommercialScore({
  rating,
  reviewsCount,
  phone,
  website,
  category,
  placeTypes = [],
}) {
  const safeRating = clampNumber(rating, 0, 5);
  const safeReviews = Math.max(0, Math.round(Number.isFinite(Number(reviewsCount)) ? Number(reviewsCount) : 0));
  const ratingScore = Math.round((safeRating / 5) * 35);
  const reviewsScore = Math.min(25, Math.round(Math.log10(safeReviews + 1) * 10));
  const phoneScore = phone ? 15 : 0;
  const websiteScore = website ? 15 : 0;
  const categoryScore = hasCommercialCategorySignal(category, placeTypes) ? 10 : (category ? 5 : 0);
  return clampNumber(ratingScore + reviewsScore + phoneScore + websiteScore + categoryScore, 0, 100);
}

function buildAcquisitionProspectNotes(prospect) {
  return [
    "Origen: Adquisicion",
    `Rating: ${safeNumber(prospect.rating, 0)}/5`,
    `Resenas: ${Math.max(0, Math.round(safeNumber(prospect.reviews_count, 0)))}`,
    `Telefono: ${prospect.phone || "-"}`,
    `Website: ${prospect.website || "-"}`,
    `Google Maps: ${prospect.maps_url || "-"}`,
  ].join("\n");
}

function normalizePhoneForCrmDedupe(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

function normalizeEmailForCrmDedupe(value) {
  return cleanText(value).toLowerCase();
}

function mergeCrmContactDataForAcquisition(base = {}, incoming = {}) {
  const baseName = trimToMaxLength(base.name || "", 180);
  const incomingName = trimToMaxLength(incoming.name || "", 180);
  const basePhone = trimToMaxLength(base.phone || "", 60);
  const incomingPhone = trimToMaxLength(incoming.phone || "", 60);
  const baseEmail = normalizeEmailForCrmDedupe(base.email || "");
  const incomingEmail = normalizeEmailForCrmDedupe(incoming.email || "");
  const baseInterest = trimToMaxLength(base.interest || "", 300);
  const incomingInterest = trimToMaxLength(incoming.interest || "", 300);
  const baseLeadId = trimToMaxLength(base.source_lead_id || "", 140);
  const incomingLeadId = trimToMaxLength(incoming.source_lead_id || "", 140);
  const baseNotes = trimToMaxLength(base.notes || "", 1600);
  const incomingNotes = trimToMaxLength(incoming.notes || "", 1600);
  const baseStage = CRM_STAGES.has(String(base.stage || "").trim().toLowerCase())
    ? String(base.stage || "").trim().toLowerCase()
    : "new";
  const nowIso = new Date().toISOString();

  let notes = baseNotes || incomingNotes;
  if (baseNotes && incomingNotes && baseNotes !== incomingNotes) {
    notes = `${baseNotes}\n${incomingNotes}`.slice(0, 1600);
  }

  return {
    client_id: trimToMaxLength(base.client_id || incoming.client_id || "", 140),
    name: baseName || incomingName || "Sin nombre",
    phone: basePhone || incomingPhone,
    email: baseEmail || incomingEmail,
    interest: incomingInterest || baseInterest,
    stage: baseStage,
    source: ACQUISITION_CRM_SOURCE,
    source_lead_id: baseLeadId || incomingLeadId,
    notes,
    created_at: base.created_at || incoming.created_at || nowIso,
    updated_at: nowIso,
    last_activity_at: nowIso,
    dedupe_phone: normalizePhoneForCrmDedupe(basePhone || incomingPhone),
    dedupe_email: normalizeEmailForCrmDedupe(baseEmail || incomingEmail),
  };
}

function buildCrmContactFromAcquisitionProspect(prospect, clientId) {
  const nowIso = new Date().toISOString();
  const name = trimToMaxLength(prospect.business_name || "", 180) || "Sin nombre";
  const phone = trimToMaxLength(prospect.phone || "", 60);
  const email = "";
  const interest = trimToMaxLength(
    [prospect.category, prospect.city].filter(Boolean).join(" - "),
    300,
  );

  return {
    client_id: trimToMaxLength(clientId, 140),
    name,
    phone,
    email,
    interest,
    stage: "new",
    source: ACQUISITION_CRM_SOURCE,
    source_lead_id: trimToMaxLength(prospect.id || "", 140),
    notes: buildAcquisitionProspectNotes(prospect),
    created_at: prospect.created_at || nowIso,
    updated_at: nowIso,
    last_activity_at: nowIso,
    dedupe_phone: normalizePhoneForCrmDedupe(phone),
    dedupe_email: normalizeEmailForCrmDedupe(email),
  };
}

function normalizeCrmStage(value, fallback = "new") {
  const normalized = cleanText(value).toLowerCase();
  return CRM_STAGES.has(normalized) ? normalized : fallback;
}

function sanitizeCrmEmail(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return "";
  if (normalized.length > 180) return null;
  return CRM_EMAIL_RE.test(normalized) ? normalized : null;
}

function sanitizeCrmPhone(value) {
  const normalized = cleanText(value);
  if (!normalized) return "";
  return sanitizeReadablePhone(normalized) || null;
}

function mergeManualCrmContactData(base = {}, incoming = {}) {
  const baseName = trimToMaxLength(base.name || "", 180);
  const incomingName = trimToMaxLength(incoming.name || "", 180);
  const basePhone = trimToMaxLength(base.phone || "", 60);
  const incomingPhone = trimToMaxLength(incoming.phone || "", 60);
  const baseEmail = normalizeEmailForCrmDedupe(base.email || "");
  const incomingEmail = normalizeEmailForCrmDedupe(incoming.email || "");
  const baseInterest = trimToMaxLength(base.interest || "", 300);
  const incomingInterest = trimToMaxLength(incoming.interest || "", 300);
  const baseLeadId = trimToMaxLength(base.source_lead_id || "", 140);
  const incomingLeadId = trimToMaxLength(incoming.source_lead_id || "", 140);
  const baseNotes = trimToMaxLength(base.notes || "", 1600);
  const incomingNotes = trimToMaxLength(incoming.notes || "", 1600);
  const baseStage = normalizeCrmStage(base.stage, "new");
  const incomingStage = normalizeCrmStage(incoming.stage, baseStage);
  const baseSource = trimToMaxLength(base.source || "", 80);
  const incomingSource = trimToMaxLength(incoming.source || "", 80);
  const nowIso = new Date().toISOString();

  let notes = baseNotes || incomingNotes;
  if (baseNotes && incomingNotes && baseNotes !== incomingNotes) {
    notes = `${baseNotes}\n${incomingNotes}`.slice(0, 1600);
  }

  return {
    client_id: trimToMaxLength(base.client_id || incoming.client_id || "", 140),
    name: baseName || incomingName || "Sin nombre",
    phone: basePhone || incomingPhone,
    email: baseEmail || incomingEmail,
    interest: incomingInterest || baseInterest,
    stage: incomingStage || baseStage,
    source: baseSource || incomingSource || CRM_MANUAL_SOURCE,
    source_lead_id: baseLeadId || incomingLeadId,
    notes,
    created_at: base.created_at || incoming.created_at || nowIso,
    updated_at: nowIso,
    last_activity_at: nowIso,
    dedupe_phone: normalizePhoneForCrmDedupe(basePhone || incomingPhone),
    dedupe_email: normalizeEmailForCrmDedupe(baseEmail || incomingEmail),
  };
}

function mapCrmContactToResponse(record = {}) {
  return {
    id: trimToMaxLength(record.id || "", 140),
    name: trimToMaxLength(record.name || "", 180),
    phone: trimToMaxLength(record.phone || "", 60),
    email: normalizeEmailForCrmDedupe(record.email || ""),
    interest: trimToMaxLength(record.interest || "", 300),
    stage: normalizeCrmStage(record.stage, "new"),
    source: trimToMaxLength(record.source || CRM_MANUAL_SOURCE, 80) || CRM_MANUAL_SOURCE,
    sourceLeadId: trimToMaxLength(record.source_lead_id || "", 140) || null,
    notes: trimToMaxLength(record.notes || "", 1600),
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null,
    lastActivityAt: record.last_activity_at || record.updated_at || record.created_at || null,
  };
}

function sortCrmContacts(records = []) {
  return [...records].sort((left, right) =>
    String(right.last_activity_at || right.updated_at || right.created_at || "")
      .localeCompare(String(left.last_activity_at || left.updated_at || left.created_at || "")));
}

function mapAcquisitionProspectToResponse(record = {}) {
  return {
    id: trimToMaxLength(record.id || "", 140),
    businessName: trimToMaxLength(record.business_name || "", 180),
    category: trimToMaxLength(record.category || "", 160),
    city: trimToMaxLength(record.city || "", 120),
    country: trimToMaxLength(record.country || "", 120),
    address: trimToMaxLength(record.address || "", 240),
    phone: trimToMaxLength(record.phone || "", 60),
    website: trimToMaxLength(record.website || "", 500),
    rating: Number.isFinite(Number(record.rating)) ? Number(record.rating) : 0,
    reviewsCount: Math.max(0, Math.round(safeNumber(record.reviews_count, 0))),
    commercialScore: Math.max(0, Math.round(safeNumber(record.commercial_score, 0))),
    mapsUrl: trimToMaxLength(record.maps_url || "", 500),
    status: normalizeAcquisitionStatus(record.status),
    source: trimToMaxLength(record.source || ACQUISITION_SOURCE, 80) || ACQUISITION_SOURCE,
  };
}

function prospectMatchesAcquisitionFilters(record = {}, filters = {}) {
  const normalizedStatus = cleanText(filters.status || "").toLowerCase();
  if (normalizedStatus && normalizedStatus !== "all" && normalizeAcquisitionStatus(record.status) !== normalizedStatus) {
    return false;
  }

  const minScore = parseOptionalMinScore(filters.minScore);
  if (minScore != null && safeNumber(record.commercial_score, 0) < minScore) {
    return false;
  }

  const categoryNeedle = normalizeComparableText(filters.category || "");
  const cityNeedle = normalizeComparableText(filters.city || "");
  const countryNeedle = normalizeComparableText(filters.country || "");

  if (categoryNeedle && !normalizeComparableText(record.category || "").includes(categoryNeedle)) return false;
  if (cityNeedle && !normalizeComparableText(record.city || "").includes(cityNeedle)) return false;
  if (countryNeedle && !normalizeComparableText(record.country || "").includes(countryNeedle)) return false;
  return true;
}

async function requireClientAuth(req, res) {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return decoded;
}

async function fetchGoogleAcquisitionPlaces({ category, city, country }) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    const error = new Error("Acquisition search is not configured");
    error.httpStatus = 500;
    error.code = "ACQUISITION_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(ACQUISITION_GOOGLE_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": ACQUISITION_GOOGLE_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: buildAcquisitionTextQuery({ category, city, country }),
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const parsedBody = safeJsonParse(rawText, {});
    if (!response.ok) {
      console.error("acquisition google search error", {
        status: response.status,
        body: parsedBody && typeof parsedBody === "object" ? parsedBody : rawText.slice(0, 500),
      });
      const error = new Error("Google Places search failed");
      error.httpStatus = 502;
      throw error;
    }

    if (!parsedBody || typeof parsedBody !== "object" || !Array.isArray(parsedBody.places)) {
      return [];
    }

    return parsedBody.places;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Google Places search timed out");
      timeoutError.httpStatus = 502;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAcquisitionProspectRecord(place = {}, existingRecord = null, searchParams = {}, clientId = "") {
  const externalId = trimToMaxLength(place.id || "", 180);
  const id = existingRecord?.id || buildAcquisitionProspectDocId(clientId, externalId);
  const businessName = trimToMaxLength(place?.displayName?.text || existingRecord?.business_name || "", 180);
  const category = normalizeAcquisitionCategory(place, existingRecord?.category || searchParams.category || "");
  const city = extractPlaceAddressComponent(place, ["locality", "postal_town", "administrative_area_level_2"])
    || trimToMaxLength(existingRecord?.city || searchParams.city || "", 120);
  const country = extractPlaceAddressComponent(place, ["country"])
    || trimToMaxLength(existingRecord?.country || searchParams.country || "", 120);
  const address = trimToMaxLength(place.formattedAddress || existingRecord?.address || "", 240);
  const phone = sanitizeReadablePhone(
    place.internationalPhoneNumber || place.nationalPhoneNumber || existingRecord?.phone || "",
  );
  const website = sanitizeHttpUrl(place.websiteUri || existingRecord?.website || "", { maxLength: 500 });
  const rating = Number.isFinite(Number(place.rating))
    ? Number(Number(place.rating).toFixed(1))
    : safeNumber(existingRecord?.rating, 0);
  const reviewsCount = Number.isFinite(Number(place.userRatingCount))
    ? Math.max(0, Math.round(Number(place.userRatingCount)))
    : Math.max(0, Math.round(safeNumber(existingRecord?.reviews_count, 0)));
  const mapsUrl = sanitizeHttpUrl(
    place.googleMapsUri
      || existingRecord?.maps_url
      || buildFallbackMapsUrl({
        businessName,
        address,
        city,
        country,
      }),
    { maxLength: 500 },
  );
  const status = normalizeAcquisitionStatus(existingRecord?.status || "pending");
  const commercialScore = calculateCommercialScore({
    rating,
    reviewsCount,
    phone,
    website,
    category,
    placeTypes: Array.isArray(place.types) ? place.types : [],
  });

  return {
    id,
    client_id: trimToMaxLength(clientId, 140),
    external_id: externalId,
    business_name: businessName,
    category,
    city,
    country,
    address,
    phone,
    website,
    rating,
    reviews_count: reviewsCount,
    commercial_score: commercialScore,
    maps_url: mapsUrl,
    status,
    source: ACQUISITION_SOURCE,
    crm_contact_id: trimToMaxLength(existingRecord?.crm_contact_id || "", 140) || null,
    created_at: existingRecord?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function listAcquisitionProspectsByClient(clientId) {
  const snap = await firestore.collection("acquisition_prospects").where("client_id", "==", clientId).get();
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
}

async function upsertCrmContactFromAcquisitionProspectTx(tx, prospectRecord, clientId) {
  const incomingContact = buildCrmContactFromAcquisitionProspect(prospectRecord, clientId);
  const contactsSnap = await tx.get(
    firestore.collection("crm_contacts").where("client_id", "==", clientId).limit(5000),
  );
  const desiredContactId = trimToMaxLength(prospectRecord.crm_contact_id || "", 140);
  const desiredSourceLeadId = trimToMaxLength(prospectRecord.id || "", 140);
  const desiredPhone = normalizePhoneForCrmDedupe(incomingContact.phone || "");
  const desiredEmail = normalizeEmailForCrmDedupe(incomingContact.email || "");

  let matchedDoc = null;
  for (const docSnap of contactsSnap.docs) {
    const row = docSnap.data() || {};
    const rowPhone = normalizePhoneForCrmDedupe(row.dedupe_phone || row.phone || "");
    const rowEmail = normalizeEmailForCrmDedupe(row.dedupe_email || row.email || "");
    const rowSourceLeadId = trimToMaxLength(row.source_lead_id || "", 140);

    if (desiredContactId && docSnap.id === desiredContactId) {
      matchedDoc = docSnap;
      break;
    }
    if (desiredSourceLeadId && rowSourceLeadId === desiredSourceLeadId) {
      matchedDoc = docSnap;
      break;
    }
    if (desiredPhone && rowPhone && rowPhone === desiredPhone) {
      matchedDoc = docSnap;
      break;
    }
    if (desiredEmail && rowEmail && rowEmail === desiredEmail) {
      matchedDoc = docSnap;
      break;
    }
  }

  const nowIso = new Date().toISOString();
  if (!matchedDoc) {
    const contactRef = desiredContactId
      ? firestore.collection("crm_contacts").doc(desiredContactId)
      : firestore.collection("crm_contacts").doc();
    tx.set(contactRef, incomingContact);
    tx.set(
      firestore.collection("activity_events").doc(),
      {
        client_id: clientId,
        entity_type: "contact",
        entity_id: contactRef.id,
        type: "contact_created",
        payload_json: {
          reason: "acquisition_approval",
          source: ACQUISITION_CRM_SOURCE,
          source_lead_id: desiredSourceLeadId || null,
        },
        created_at: nowIso,
        created_by: clientId,
      },
      { merge: true },
    );
    return {
      crmContactId: contactRef.id,
      action: "created",
    };
  }

  const mergedContact = mergeCrmContactDataForAcquisition(matchedDoc.data() || {}, incomingContact);
  tx.set(matchedDoc.ref, mergedContact, { merge: true });
  tx.set(
    firestore.collection("activity_events").doc(),
    {
      client_id: clientId,
      entity_type: "contact",
      entity_id: matchedDoc.id,
      type: "dedupe_merge",
      payload_json: {
        reason: "acquisition_approval",
        source: ACQUISITION_CRM_SOURCE,
        source_lead_id: desiredSourceLeadId || null,
      },
      created_at: nowIso,
      created_by: clientId,
    },
    { merge: true },
  );
  return {
    crmContactId: matchedDoc.id,
    action: "merged",
  };
}

function safeJsonParse(input, fallback = null) {
  if (typeof input !== "string") return fallback;
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function summarizeHistory(history = [], maxItems = 12) {
  if (!Array.isArray(history)) return "";
  return history
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-maxItems)
    .map((item) => `${item.role}: ${cleanText(item.content || "").slice(0, 280)}`)
    .filter(Boolean)
    .join(" | ");
}

function resolveLeadChatSlug(widgetData, fallbackWidgetId) {
  const slug = cleanText(widgetData?.lead_chat_slug || "");
  if (slug) return slug.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 64);
  return String(fallbackWidgetId || "").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 64);
}

function buildLeadChatUrl(slug) {
  const base = cleanText(process.env.PUBLIC_APP_URL || "") || "https://leads-widget.vercel.app";
  try {
    const url = new URL(`/lead-chat/${encodeURIComponent(slug)}`, base);
    return url.toString();
  } catch {
    return `https://leads-widget.vercel.app/lead-chat/${encodeURIComponent(slug)}`;
  }
}

function buildDefaultBrandingLink(clientId) {
  const fallbackBase = "https://leads-widget.vercel.app";
  const configuredBase = cleanText(process.env.PUBLIC_APP_URL || "");
  const base = configuredBase || fallbackBase;
  try {
    const url = new URL("/crear-ahora", base);
    if (clientId) url.searchParams.set("ref", String(clientId));
    return url.toString();
  } catch {
    return clientId
      ? `${fallbackBase}/crear-ahora?ref=${encodeURIComponent(String(clientId))}`
      : `${fallbackBase}/crear-ahora`;
  }
}

function sanitizeTrackingId(value, { regex, maxLength, transform = (input) => input }) {
  const normalized = cleanText(value);
  if (!normalized) return null;

  const transformed = transform(normalized);
  if (!transformed || transformed.length > maxLength) return null;
  return regex.test(transformed) ? transformed : null;
}

function sanitizeFacebookPixelId(value) {
  return sanitizeTrackingId(value, {
    regex: FACEBOOK_PIXEL_ID_RE,
    maxLength: MAX_FACEBOOK_PIXEL_ID_LENGTH,
    transform: (input) => input.replace(/\s+/g, ""),
  });
}

function sanitizeTikTokPixelId(value) {
  return sanitizeTrackingId(value, {
    regex: TIKTOK_PIXEL_ID_RE,
    maxLength: MAX_TIKTOK_PIXEL_ID_LENGTH,
    transform: (input) => input.replace(/\s+/g, ""),
  });
}

function sanitizeGoogleTagId(value) {
  return sanitizeTrackingId(value, {
    regex: GOOGLE_TAG_ID_RE,
    maxLength: MAX_GOOGLE_TAG_ID_LENGTH,
    transform: (input) => input.replace(/\s+/g, "").toUpperCase(),
  });
}

function buildTrackingConfig(widgetData = {}) {
  return {
    facebookPixelId: sanitizeFacebookPixelId(widgetData.facebook_pixel_id),
    tiktokPixelId: sanitizeTikTokPixelId(widgetData.tiktok_pixel_id),
    googleTagId: sanitizeGoogleTagId(widgetData.google_tag_id),
  };
}

async function getWidgetConfigByIdentity(widgetId) {
  let q = await firestore.collection("widget_configs").where("widget_id", "==", widgetId).limit(1).get();
  if (q.empty) {
    q = await firestore.collection("widget_configs").where("user_id", "==", widgetId).limit(1).get();
  }
  if (q.empty) {
    q = await firestore.collection("widget_configs").where("lead_chat_slug", "==", widgetId).limit(1).get();
  }
  if (q.empty) return null;

  const doc = q.docs[0];
  return { id: doc.id, ...doc.data() };
}

function buildWidgetSecurityScopeIds(widgetIdentity, widgetData) {
  const raw = [widgetIdentity, widgetData?.id, widgetData?.widget_id];
  return Array.from(
    new Set(
      raw
        .map((value) => cleanText(value || ""))
        .filter(Boolean),
    ),
  ).slice(0, 10);
}

function resolvePrimaryWidgetSecurityId(widgetIdentity, widgetData) {
  return cleanText(widgetData?.id || "") || cleanText(widgetIdentity || "");
}

function mapWidgetToPublicConfig(widgetData, profileData = {}, identity, partnerData = {}) {
  const fallbackWidgetId = widgetData?.widget_id || widgetData?.id || identity;
  const resolvedClientId = widgetData?.user_id || identity;
  const leadChatSlug = resolveLeadChatSlug(widgetData, fallbackWidgetId);
  const consentText = cleanText(widgetData?.consent_text || "")
    || "Acepto ser contactado por telefono o mensajes para continuar con mi solicitud.";
  const consentTextVersion = cleanText(widgetData?.consent_text_version || "") || "v1";
  const iacloserRedirectUrl = sanitizeHttpUrl(
    widgetData?.icloser_redirect_url || process.env.IACLOSER_DEFAULT_REDIRECT_URL || "",
  );
  const experienceModeRaw = cleanText(widgetData?.experience_mode || "").toLowerCase();
  const experienceMode = experienceModeRaw === "lead_chat" ? "lead_chat" : "widget";
  const leadChatHeadline = cleanText(widgetData?.lead_chat_headline || "");
  const leadChatSubheadline = cleanText(widgetData?.lead_chat_subheadline || "");
  const leadChatEyebrow = cleanText(widgetData?.lead_chat_eyebrow || "");
  const leadChatBadgeText = cleanText(widgetData?.lead_chat_badge_text || "");
  const leadChatOfferTitle = cleanText(widgetData?.lead_chat_offer_title || "");
  const leadChatOfferDescription = cleanText(widgetData?.lead_chat_offer_description || "");
  const leadChatCtaLabel = cleanText(widgetData?.lead_chat_cta_label || "");
  const leadChatLiveToasts = Array.isArray(widgetData?.lead_chat_live_toasts)
    ? widgetData.lead_chat_live_toasts.map((value) => cleanText(value)).filter(Boolean).slice(0, 12)
    : (typeof widgetData?.lead_chat_live_toasts === "string"
      ? widgetData.lead_chat_live_toasts.split("\n").map((value) => cleanText(value)).filter(Boolean).slice(0, 12)
      : []);
  const trackingConfig = buildTrackingConfig(widgetData);
  const clientPlanType = String(profileData?.plan_type || "").toLowerCase();
  const canUseCustomBranding = clientPlanType === "plus";
  const requestedHideBranding = widgetData?.hide_branding === true;
  const partnerBrandingText = cleanText(
    partnerData?.branding?.branding_text
      || partnerData?.branding?.agency_name
      || partnerData?.name
      || "",
  );
  const preferredBrandingText = cleanText(widgetData?.branding_text || "") || partnerBrandingText;
  const requestedBrandingLink = sanitizeHttpUrl(
    widgetData?.branding_link
      || partnerData?.branding?.branding_link
      || partnerData?.branding?.cta_url
      || "",
  );
  const brandingLink = requestedBrandingLink || buildDefaultBrandingLink(resolvedClientId);
  let testimonials = [];
  if (typeof widgetData?.testimonials_json === "string" && widgetData.testimonials_json.trim()) {
    try {
      const parsed = JSON.parse(widgetData.testimonials_json);
      if (Array.isArray(parsed)) testimonials = parsed;
    } catch {
      testimonials = [];
    }
  } else if (Array.isArray(widgetData?.testimonials)) {
    testimonials = widgetData.testimonials;
  }

  const teaserMessages = Array.isArray(widgetData?.teaser_messages)
    ? widgetData.teaser_messages
    : (typeof widgetData?.teaser_messages === "string"
      ? widgetData.teaser_messages.split("\n").map((v) => v.trim()).filter(Boolean)
      : []);

  const quickReplies = Array.isArray(widgetData?.quick_replies)
    ? widgetData.quick_replies
    : (typeof widgetData?.quick_replies === "string"
      ? widgetData.quick_replies.split("\n").map((v) => v.trim()).filter(Boolean)
      : []);

  return {
    clientId: resolvedClientId,
    widgetId: fallbackWidgetId,
    businessName: widgetData?.business_name || profileData?.business_name || "LeadWidget",
    primaryColor: widgetData?.primary_color || "#00C185",
    whatsappDestination: widgetData?.whatsapp_destination || profileData?.whatsapp_number || "",
    language: widgetData?.language || "es",
    welcomeMessage: widgetData?.welcome_message || "Hola! Soy tu asistente virtual.",
    template: widgetData?.template || "general",
    chatPlaceholder: widgetData?.chat_placeholder || "Escribe tu mensaje...",
    vibrationIntensity: widgetData?.vibration_intensity || "soft",
    triggerDelay: Number(widgetData?.trigger_delay || 5),
    exitIntentEnabled: widgetData?.trigger_exit_intent !== false,
    exitIntentTitle: widgetData?.exit_intent_title || "Espera!",
    exitIntentDescription: widgetData?.exit_intent_description || "Tienes alguna consulta antes de salir?",
    exitIntentCta: widgetData?.exit_intent_cta || "Chatear ahora",
    teaserMessages,
    quickReplies,
    testimonials,
    launcherIcon: widgetData?.launcher_icon || "",
    hideBranding: canUseCustomBranding ? requestedHideBranding : false,
    brandingText: canUseCustomBranding ? preferredBrandingText : "",
    brandingLink: canUseCustomBranding ? brandingLink : buildDefaultBrandingLink(resolvedClientId),
    ai_enabled: widgetData?.ai_enabled === true,
    ai_provider: widgetData?.ai_provider || "openai",
    ai_api_key: widgetData?.ai_api_key || "",
    ai_model: widgetData?.ai_model || "gpt-4o-mini",
    ai_system_prompt: widgetData?.ai_system_prompt || "",
    business_description: widgetData?.business_description || "",
    ai_temperature: Number(widgetData?.ai_temperature || 0.7),
    ai_max_tokens: Number(widgetData?.ai_max_tokens || 500),
    facebookPixelId: trackingConfig.facebookPixelId,
    tiktokPixelId: trackingConfig.tiktokPixelId,
    googleTagId: trackingConfig.googleTagId,
    experienceMode,
    leadChatSlug,
    leadChatUrl: buildLeadChatUrl(leadChatSlug),
    consentText,
    consentTextVersion,
    iacloserRedirectUrl,
    iacloserEnabled: Boolean(iacloserRedirectUrl || getIaCloserApiUrl()),
    leadChatHeadline,
    leadChatSubheadline,
    leadChatEyebrow,
    leadChatBadgeText,
    leadChatOfferTitle,
    leadChatOfferDescription,
    leadChatCtaLabel,
    leadChatLiveToasts,
    customTrackingCode: "",
    updatedAt: widgetData?.updated_at || widgetData?.created_at || null,
  };
}

function getOpenAIForWidget(widgetId, aiConfig) {
  const defaultKey = (process.env.OPENAI_API_KEY || "").trim();
  const key = widgetId === "demo-landing" ? defaultKey : (aiConfig?.ai_api_key || "").trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

async function decodeTokenIfPresent(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  try {
    return await firebaseAdmin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

async function isSuperAdmin(decoded) {
  const email = (decoded?.email || "").toLowerCase();
  if (SUPERADMIN_EMAILS.has(email)) return true;
  if (!decoded?.uid) return false;

  const roleDoc = await firestore.collection("user_roles").doc(decoded.uid).get();
  return roleDoc.exists && roleDoc.data()?.role === "superadmin";
}

function normalizePartnerRole(role) {
  const candidate = String(role || "").trim().toLowerCase();
  if (candidate === "admin" || candidate === "partner_admin") return "partner_admin";
  if (candidate === "staff" || candidate === "partner_staff") return "partner_staff";
  return "partner_staff";
}

function isPartnerRole(role) {
  return PARTNER_ROLES.has(String(role || "").trim().toLowerCase());
}

function safeNumber(input, fallback = 0) {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function roundCurrency(input) {
  return Math.round(safeNumber(input, 0) * 100) / 100;
}

function csvClean(value) {
  if (value == null) return "";
  const raw = String(value);
  if (!/[,"\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePartnerCode(input) {
  const code = String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  if (!code) return "";
  return code.slice(0, 24);
}

function toPeriodKey(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function buildPartnerCheckoutUrl(req, params = {}) {
  const baseUrl = (process.env.PUBLIC_APP_URL || "").trim() || `${req.protocol}://${req.get("host")}`;
  const url = new URL("/register", baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function getPartnerByCode(partnerCode) {
  const normalized = normalizePartnerCode(partnerCode);
  if (!normalized) return null;

  const q = await firestore.collection("partners").where("code", "==", normalized).limit(1).get();
  if (q.empty) return null;
  return { id: q.docs[0].id, ...q.docs[0].data() };
}

async function getPartnerMembership(uid) {
  const docSnap = await firestore.collection("partner_users").doc(uid).get();
  if (!docSnap.exists) return null;
  const data = docSnap.data() || {};
  return {
    id: docSnap.id,
    partner_id: data.partner_id || null,
    role: normalizePartnerRole(data.role),
    status: data.status || "active",
    email: data.email || null,
    invited_by: data.invited_by || null,
  };
}

function isClientAccountProfile(profile = {}) {
  const accountType = String(profile?.account_type || "").toLowerCase();
  if (!accountType) return true;
  return !accountType.startsWith("partner");
}

async function getPartnerInternalUserIds(partnerId) {
  if (!partnerId) return new Set();
  const snap = await firestore.collection("partner_users").where("partner_id", "==", partnerId).get();
  const internalUserIds = new Set();
  snap.docs.forEach((docSnap) => internalUserIds.add(docSnap.id));
  return internalUserIds;
}

async function buildAuthContext(req) {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    return { ok: false, decoded: null, uid: null, role: null, isSuperAdmin: false, partnerId: null, partnerMembership: null };
  }

  const superAdmin = await isSuperAdmin(decoded);
  if (superAdmin) {
    return {
      ok: true,
      decoded,
      uid: decoded.uid,
      role: "superadmin",
      isSuperAdmin: true,
      partnerId: null,
      partnerMembership: null,
    };
  }

  const membership = await getPartnerMembership(decoded.uid);
  if (membership && PARTNER_USER_STATUSES.has(String(membership.status || "").toLowerCase()) && membership.status !== "suspended") {
    return {
      ok: true,
      decoded,
      uid: decoded.uid,
      role: membership.role,
      isSuperAdmin: false,
      partnerId: membership.partner_id || null,
      partnerMembership: membership,
    };
  }

  return {
    ok: true,
    decoded,
    uid: decoded.uid,
    role: "client",
    isSuperAdmin: false,
    partnerId: null,
    partnerMembership: membership,
  };
}

async function requirePartnerContext(req, res, options = {}) {
  const { requireAdmin = false, allowSuperAdmin = true } = options;
  const authCtx = await buildAuthContext(req);
  if (!authCtx.ok || !authCtx.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  if (authCtx.isSuperAdmin && allowSuperAdmin) {
    return authCtx;
  }

  if (!isPartnerRole(authCtx.role) || !authCtx.partnerId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  if (requireAdmin && authCtx.role !== "partner_admin") {
    res.status(403).json({ error: "Partner admin role required" });
    return null;
  }

  return authCtx;
}

async function createCommissionLedgerForPayment({
  paymentId,
  userId,
  partnerId: explicitPartnerId = null,
  amount,
  currency,
  planType,
  paymentMethod,
  paymentStatus,
  paymentDate,
}) {
  if (!paymentId || !userId) return null;
  const normalizedStatus = String(paymentStatus || "").toLowerCase();
  if (!["completed", "verified", "active"].includes(normalizedStatus)) return null;

  const profileSnap = await firestore.collection("profiles").doc(userId).get();
  if (!profileSnap.exists) return null;
  const profile = profileSnap.data() || {};
  const partnerId = explicitPartnerId || profile.partner_id || null;
  if (!partnerId) return null;

  const existing = await firestore
    .collection("commission_ledger")
    .where("payment_id", "==", paymentId)
    .limit(1)
    .get();
  if (!existing.empty) {
    return { idempotent: true };
  }

  const partnerSnap = await firestore.collection("partners").doc(partnerId).get();
  if (!partnerSnap.exists) return null;
  const partner = partnerSnap.data() || {};

  const paymentsSnap = await firestore
    .collection("payments")
    .where("user_id", "==", userId)
    .get();
  const previousPaidCount = paymentsSnap.docs.filter((d) => {
    const data = d.data() || {};
    const status = String(data.status || "").toLowerCase();
    if (!["completed", "verified", "active"].includes(status)) return false;
    if (d.id === paymentId) return false;
    return true;
  }).length;

  const isFirstPayment = previousPaidCount === 0;
  const firstRate = safeNumber(partner.commission_first_rate, 0.5);
  const recurringRate = safeNumber(partner.commission_recurring_rate, 0.3);
  const rateApplied = isFirstPayment ? firstRate : recurringRate;

  const baseAmount = roundCurrency(amount);
  const commissionAmount = roundCurrency(baseAmount * rateApplied);
  const nowIso = new Date().toISOString();
  const paidAtIso = paymentDate || nowIso;
  const period = toPeriodKey(paidAtIso);

  const idempotencyKey = `${partnerId}|${userId}|${paymentId}|${period}`;
  const idemCheck = await firestore
    .collection("commission_ledger")
    .where("idempotency_key", "==", idempotencyKey)
    .limit(1)
    .get();
  if (!idemCheck.empty) {
    return { idempotent: true };
  }

  await firestore.collection("commission_ledger").add({
    partner_id: partnerId,
    client_user_id: userId,
    payment_id: paymentId,
    payment_method: paymentMethod || null,
    payment_status: normalizedStatus,
    period,
    currency: currency || "USD",
    plan_type: planType || profile.plan_type || "pro",
    base_amount: baseAmount,
    rate_applied: rateApplied,
    commission_amount: commissionAmount,
    is_first_payment: isFirstPayment,
    policy_version: "partner_commission_v1",
    status: "pending",
    idempotency_key: idempotencyKey,
    created_at: nowIso,
    updated_at: nowIso,
  });

  return { idempotent: false, isFirstPayment, commissionAmount, rateApplied };
}

function resolvePlanBaseAmountPen(planType, profile = {}) {
  const normalizedPlan = String(planType || profile?.plan_type || "pro").toLowerCase();
  const configuredAmount = safeNumber(
    profile?.monthly_price_pen ?? profile?.plan_amount_pen ?? profile?.plan_amount,
    0,
  );
  if (configuredAmount > 0) return roundCurrency(configuredAmount);
  return roundCurrency(PLAN_BASE_AMOUNT_PEN[normalizedPlan] || PLAN_BASE_AMOUNT_PEN.pro);
}

async function ensureManualPlusCommissionRowsForPartner(partnerId, period = toPeriodKey(new Date())) {
  if (!partnerId) return { inserted: 0 };

  const partnerSnap = await firestore.collection("partners").doc(partnerId).get();
  if (!partnerSnap.exists) return { inserted: 0 };
  const partner = partnerSnap.data() || {};
  const partnerStatus = String(partner.status || "active").toLowerCase();
  if (partnerStatus !== "active") return { inserted: 0 };

  const clientsSnap = await firestore.collection("profiles").where("partner_id", "==", partnerId).get();
  const activePlusClients = clientsSnap.docs.filter((docSnap) => {
    const profile = docSnap.data() || {};
    const status = String(profile.subscription_status || "").toLowerCase();
    const plan = String(profile.plan_type || "").toLowerCase();
    return status === "active" && plan === "plus";
  });
  if (!activePlusClients.length) return { inserted: 0 };

  const ledgerSnap = await firestore.collection("commission_ledger").where("partner_id", "==", partnerId).get();
  const rows = ledgerSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  const rowsByClient = new Map();
  rows.forEach((row) => {
    const clientUserId = String(row.client_user_id || "").trim();
    if (!clientUserId) return;
    if (!rowsByClient.has(clientUserId)) rowsByClient.set(clientUserId, []);
    rowsByClient.get(clientUserId).push(row);
  });

  const firstRate = safeNumber(partner.commission_first_rate, 0.5);
  const recurringRate = safeNumber(partner.commission_recurring_rate, 0.3);
  const nowIso = new Date().toISOString();
  let inserted = 0;

  for (const clientSnap of activePlusClients) {
    const clientUserId = clientSnap.id;
    const profile = clientSnap.data() || {};
    const existingRows = rowsByClient.get(clientUserId) || [];
    const alreadyInPeriod = existingRows.some((row) => {
      if (String(row.period || "") !== period) return false;
      const status = String(row.status || "pending").toLowerCase();
      return status !== "void";
    });
    if (alreadyInPeriod) continue;

    const hasPrevious = existingRows.some((row) => String(row.status || "").toLowerCase() !== "void");
    const rateApplied = hasPrevious ? recurringRate : firstRate;
    const baseAmount = resolvePlanBaseAmountPen("plus", profile);
    const commissionAmount = roundCurrency(baseAmount * rateApplied);
    const idempotencyKey = `manual_external|${partnerId}|${clientUserId}|${period}`;

    const idemExists = rows.some((row) => String(row.idempotency_key || "") === idempotencyKey);
    if (idemExists) continue;

    await firestore.collection("commission_ledger").add({
      partner_id: partnerId,
      client_user_id: clientUserId,
      payment_id: null,
      payment_method: "manual_external",
      payment_status: "external_confirmed",
      period,
      currency: "PEN",
      plan_type: "plus",
      base_amount: baseAmount,
      rate_applied: rateApplied,
      commission_amount: commissionAmount,
      is_first_payment: !hasPrevious,
      policy_version: "partner_commission_v1",
      status: "pending",
      entry_source: "auto_manual_plus_active",
      idempotency_key: idempotencyKey,
      created_at: nowIso,
      updated_at: nowIso,
    });

    rows.push({ idempotency_key: idempotencyKey });
    inserted += 1;
  }

  return { inserted };
}

async function createOrReusePartner({
  uid,
  email,
  displayName,
  providedCode,
  commissionFirstRate = 0.5,
  commissionRecurringRate = 0.3,
}) {
  const normalizedProvidedCode = normalizePartnerCode(providedCode);
  let chosenCode = normalizedProvidedCode || normalizePartnerCode(String(displayName || "PARTNER").replace(/\s+/g, "_"));
  if (!chosenCode) chosenCode = `PARTNER_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const attemptFind = async (code) => {
    const q = await firestore.collection("partners").where("code", "==", code).limit(1).get();
    return q.empty ? null : { id: q.docs[0].id, ...q.docs[0].data() };
  };

  let tries = 0;
  let existing = await attemptFind(chosenCode);
  while (existing && existing.created_by !== uid && tries < 5) {
    chosenCode = `${chosenCode}_${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    existing = await attemptFind(chosenCode);
    tries += 1;
  }

  if (existing && existing.created_by === uid) {
    return { partnerId: existing.id, code: existing.code || chosenCode, created: false };
  }

  const nowIso = new Date().toISOString();
  const partnerRef = firestore.collection("partners").doc();
  await partnerRef.set({
    name: displayName || "Partner",
    code: chosenCode,
    status: "active",
    commission_first_rate: safeNumber(commissionFirstRate, 0.5),
    commission_recurring_rate: safeNumber(commissionRecurringRate, 0.3),
    payout_method: null,
    branding: {
      branding_text: displayName || "Partner",
      branding_link: "",
      agency_name: displayName || "Partner",
      cta_url: "",
    },
    created_by: uid,
    created_by_email: email || null,
    created_at: nowIso,
    updated_at: nowIso,
  });

  return { partnerId: partnerRef.id, code: chosenCode, created: true };
}

app.get("/health", (_, res) => {
  return res.status(200).json({ ok: true, service: "leads-widget-backend", time: new Date().toISOString() });
});

app.post("/api/track", async (req, res) => {
  const { widgetId, eventType } = req.body || {};
  if (!widgetId) return res.status(400).json({ error: "widgetId is required" });

  const clientIp = clientIpFrom(req);
  const userAgent = req.headers["user-agent"] || "Unknown";
  const referer = req.headers["referer"] || req.headers["referrer"] || "Direct";
  const now = new Date();

  try {
    let blockedScopeIds = [cleanText(widgetId || "")].filter(Boolean);
    try {
      if (widgetId !== "demo-landing") {
        const widgetData = await getWidgetConfigByIdentity(widgetId);
        blockedScopeIds = buildWidgetSecurityScopeIds(widgetId, widgetData);
      }
    } catch (error) {
      console.error("track widget scope resolve error", error?.message || error);
    }

    try {
      const blocked = blockedScopeIds.length <= 1
        ? await firestore
          .collection("blocked_ips")
          .where("ip_address", "==", clientIp)
          .where("widget_id", "==", blockedScopeIds[0] || cleanText(widgetId || ""))
          .limit(1)
          .get()
        : await firestore
          .collection("blocked_ips")
          .where("ip_address", "==", clientIp)
          .where("widget_id", "in", blockedScopeIds)
          .limit(1)
          .get();

      if (!blocked.empty) {
        return res.status(200).json({ success: true, blocked: true });
      }
    } catch (error) {
      console.error("track blocked check error", error?.message || error);
    }

    try {
      const recentTrack = await firestore
        .collection("analytics")
        .where("ip", "==", clientIp)
        .where("widget_id", "==", widgetId)
        .where("created_at", ">", new Date(Date.now() - 5000).toISOString())
        .limit(1)
        .get();

      if (!recentTrack.empty && (eventType || "view") === "view") {
        return res.status(200).json({ success: true, cached: true });
      }
    } catch (error) {
      console.error("track de-dup check error", error?.message || error);
    }

    await firestore.collection("analytics").add({
      widget_id: widgetId,
      event_type: eventType || "view",
      ip: clientIp,
      user_agent: userAgent,
      referer,
      date: toDateKey(now),
      created_at: now.toISOString(),
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("track error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history, widgetId, userTimezone } = req.body || {};
  if (!message || !widgetId) {
    return res.status(400).json({ error: "Message and widgetId are required" });
  }

  const clientIp = clientIpFrom(req);
  let widgetData = null;
  let profileData = {};
  let blockedScopeIds = [cleanText(widgetId || "")].filter(Boolean);
  let primaryBlockedWidgetId = cleanText(widgetId || "");

  const forbiddenPatterns = [
    /jailbreak/i,
    /dan mode/i,
    /ignore (previous )?instructions/i,
    /ignora (tus )?instrucciones/i,
    /olvida tus reglas/i,
    /system prompt/i,
    /developer mode/i,
    /modo desarrollador/i,
  ];

  try {
    if (widgetId !== "demo-landing") {
      widgetData = await getWidgetConfigByIdentity(widgetId);
      if (!widgetData) {
        return res.status(404).json({ error: "Widget not found" });
      }
      const profileDoc = await firestore.collection("profiles").doc(widgetData.user_id).get();
      profileData = profileDoc.exists ? profileDoc.data() : {};
    } else {
      profileData = {
        ai_enabled: true,
        ai_model: "gpt-4o-mini",
      };
    }

    blockedScopeIds = buildWidgetSecurityScopeIds(widgetId, widgetData);
    primaryBlockedWidgetId = resolvePrimaryWidgetSecurityId(widgetId, widgetData);

    if (forbiddenPatterns.some((pattern) => pattern.test(message))) {
      try {
        await firestore.collection("blocked_ips").add({
          widget_id: primaryBlockedWidgetId,
          ip_address: clientIp,
          reason: "Static filter: Potential jailbreak detected",
          created_at: new Date().toISOString(),
        });
      } catch {
        // ignore
      }

      return res.status(403).json({
        response: "Your behavior was identified as malicious. Access restricted.",
        blocked: true,
      });
    }

    try {
      let blockedQuery = null;
      if (blockedScopeIds.length <= 1) {
        blockedQuery = await firestore
          .collection("blocked_ips")
          .where("ip_address", "==", clientIp)
          .where("widget_id", "==", blockedScopeIds[0] || primaryBlockedWidgetId)
          .limit(1)
          .get();
      } else {
        blockedQuery = await firestore
          .collection("blocked_ips")
          .where("ip_address", "==", clientIp)
          .where("widget_id", "in", blockedScopeIds)
          .limit(1)
          .get();
      }
      if (!blockedQuery.empty) {
        return res.status(403).json({
          response: "Your access to this chat has been restricted for security.",
          blocked: true,
        });
      }
    } catch (error) {
      console.error("chat blocked check error", error?.message || error);
    }

    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentMessages = await firestore
        .collection("analytics")
        .where("ip", "==", clientIp)
        .where("event_type", "==", "message_sent")
        .where("created_at", ">", oneHourAgo)
        .get();

      const messageCount = recentMessages.size;
      const rateLimit = widgetId === "demo-landing" ? 40 : 100;
      if (messageCount >= rateLimit) {
        return res.status(429).json({
          response: "You reached the message limit for now. Please try again later.",
          rateLimited: true,
        });
      }
    } catch (error) {
      console.error("chat rate-limit check error", error?.message || error);
    }

    firestore.collection("analytics").add({
      widget_id: widgetId,
      event_type: "message_sent",
      ip: clientIp,
      created_at: new Date().toISOString(),
    }).catch(() => {});

    if (widgetId !== "demo-landing") {
      const subStatus = profileData?.subscription_status || "trial";
      const trialEnds = profileData?.trial_ends_at ? new Date(profileData.trial_ends_at) : null;
      const now = new Date();

      const isActive = ["active", "pro", "verified"].includes(subStatus);
      const isTrialValid = subStatus === "trial" && (!trialEnds || now < trialEnds);

      if (!isActive && !isTrialValid) {
        const lang = widgetData?.language || "es";
        const msg = lang === "en"
          ? "SERVICE PAUSED: Your free trial has ended. Upgrade your plan from dashboard."
          : "SERVICIO PAUSADO: Tu periodo de prueba ha finalizado. Realiza el pago en tu panel para reactivar el chat.";
        return res.status(200).json({ response: msg });
      }
    }

    const lang = widgetData?.language || "es";
    const aiEnabled = profileData?.ai_enabled !== false;
    if (!aiEnabled) {
      return res.status(200).json({
        response: lang === "en"
          ? "The virtual assistant is disabled. Enable it from dashboard."
          : "El asistente virtual esta deshabilitado. Activalo desde el dashboard.",
      });
    }

    const openai = getOpenAIForWidget(widgetId, profileData);
    if (!openai) {
      if (widgetId === "demo-landing") {
        return res.status(200).json({
          response: lang === "en"
            ? "Missing OPENAI_API_KEY in backend environment. Configure it to enable AI responses in demo."
            : "Falta OPENAI_API_KEY en el backend. Configuralo para habilitar respuestas IA en la demo.",
        });
      }

      return res.status(200).json({
        response: lang === "en"
          ? "To answer, configure your OpenAI API key in Dashboard > AI tab."
          : "Para responder, configura tu API key de OpenAI en Dashboard > pestana IA.",
      });
    }

    const tz = userTimezone || "America/Lima";
    const nowUser = new Date().toLocaleString("en-US", { timeZone: tz });
    const isLeadChatMode = widgetId !== "demo-landing"
      && String(widgetData?.experience_mode || "").toLowerCase() === "lead_chat";

    const defaultPrompt = widgetId === "demo-landing"
      ? [
          "You are LeadWidget commercial assistant.",
          "You can answer product and Partners program questions.",
          "Partners key facts: agency dashboard is separate (/partner), client always pays LeadWidget directly, commissions are 50% first successful payment and 30% recurring payments, and partner signup starts at /partners or /register?account=partner.",
          "Client pricing: Plan 30 (with LeadWidget mark) and Plan 60 (PLUS, optional agency branding).",
          "Lead Chat offer: a public full-screen page for businesses without a website (shareable link), with conversation-based qualification and richer conversion UI.",
          "Lead Chat + IACloser flow: qualify lead, ask name and phone, show explicit consent text, and only after acceptance trigger IACloser outbound call in under 60 seconds with lead context.",
          "If user asks legal/compliance questions, explain that explicit consent is mandatory before outbound calls in USA workflows.",
          "When user intent is to buy/activate, qualify quickly and then send [WHATSAPP_REDIRECT: ...] with a concise prefilled message in Spanish.",
          "Do not use [WHATSAPP_REDIRECT: ...] for informational-only questions.",
          "Keep replies short and practical.",
        ].join(" ")
      : isLeadChatMode
        ? [
            "You are a helpful assistant for this business.",
            "Your goal is to qualify leads in chat and prepare fast outbound call handoff.",
            "Flow: qualify -> ask name and phone -> confirm buying intent -> explain explicit contact consent is required -> then append [ICALLCLOSER_READY:{\"name\":\"...\",\"phone\":\"...\",\"collected_info\":\"...\"}] at the end.",
            "Do not emit ICallCloser command for informational-only requests.",
            "Keep replies short and practical.",
          ].join(" ")
        : "You are a helpful assistant for this business. Keep replies short and practical.";

    const systemPrompt =
      `CURRENT DATE/TIME FOR USER: ${nowUser} (Timezone: ${tz})\n\n` +
      `${profileData?.business_description ? `BUSINESS CONTEXT:\n${profileData.business_description}\n\n` : ""}` +
      `${profileData?.ai_system_prompt || defaultPrompt}\n\n` +
      `${lang === "en" ? "Reply in user language." : "Responde en el idioma del usuario."}\n` +
      "Keep it short (2-3 sentences).";

    const completion = await openai.chat.completions.create({
      model: profileData?.ai_model || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...((history || []).map((m) => ({ role: m.role, content: m.content }))),
        { role: "user", content: message },
      ],
      temperature: profileData?.ai_temperature || 0.7,
      max_tokens: Number(profileData?.ai_max_tokens || 500),
    });

    const aiResponse = completion?.choices?.[0]?.message?.content || "";
    if (!aiResponse) {
      throw new Error("Empty response from OpenAI");
    }

    const shouldBlockCommand = /\{?\s*block[_\s-]?user\s*\}?/i.test(aiResponse);
    const shouldBlock =
      shouldBlockCommand ||
      aiResponse.includes("Security Violation Detected") ||
      aiResponse.includes("I cannot help with that") ||
      aiResponse.includes("no puedo ayudar con eso");

    if (shouldBlock) {
      try {
        await firestore.collection("blocked_ips").add({
          widget_id: primaryBlockedWidgetId,
          ip_address: clientIp,
          reason: "AI/System detected safety violation",
          ai_raw_response: aiResponse.slice(0, 120),
          created_at: new Date().toISOString(),
        });
      } catch {
        // ignore
      }

      return res.status(200).json({
        response: "Conversation finalized for security. Access restricted.",
        blocked: true,
      });
    }

    if (aiResponse.includes("collect_lead") && widgetId !== "demo-landing" && widgetData) {
      try {
        const leadMatch = aiResponse.match(/\{"action":\s*"collect_lead"[^}]*\}/);
        if (leadMatch) {
          const leadPayload = JSON.parse(leadMatch[0]);
          await firestore.collection("leads").add({
            client_id: widgetData.user_id,
            widget_id: widgetData.id,
            name: leadPayload?.data?.name || "Interested client",
            interest: Object.entries(leadPayload?.data || {})
              .map(([k, v]) => `${k}: ${v}`)
              .join(" | "),
            phone: "Pending (confirm in WA)",
            created_at: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error("lead save error", error?.message || error);
      }
    }

    return res.status(200).json({ response: aiResponse });
  } catch (error) {
    console.error("chat error", error);
    return res.status(200).json({
      response: `Technical error: ${error?.message || "unknown"}`,
    });
  }
});

app.post("/api/icloser/handoff", async (req, res) => {
  const widgetId = cleanText(req.body?.widgetId || "");
  const name = cleanText(req.body?.name || "");
  const phone = sanitizePhoneNumber(req.body?.phone || "");
  const collectedInfo = cleanText(req.body?.collectedInfo || "");
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const consentAccepted = req.body?.consent?.accepted === true;
  const consentExplicitResponse = cleanText(
    req.body?.consent?.explicitResponse
    || req.body?.consent?.explicit_response
    || "",
  );
  const consentTextVersion = cleanText(req.body?.consent?.textVersion || "v1");
  const consentText = cleanText(req.body?.consent?.text || "");
  const clientIp = clientIpFrom(req);
  const userAgent = cleanText(req.headers["user-agent"] || "");

  if (!widgetId) {
    return res.status(400).json({ error: "widgetId is required" });
  }
  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!phone) {
    return res.status(400).json({ error: "phone is required" });
  }
  if (!consentAccepted) {
    return res.status(400).json({ error: "Explicit consent is required" });
  }
  if (!hasExplicitConsentYes(consentExplicitResponse)) {
    return res.status(400).json({ error: "Explicit consent response 'SI' is required" });
  }

  const nowIso = new Date().toISOString();

  try {
    const widgetData = await getWidgetConfigByIdentity(widgetId);
    if (!widgetData) {
      return res.status(404).json({ error: "Widget not found" });
    }

    const profileDoc = await firestore.collection("profiles").doc(widgetData.user_id).get();
    const profileData = profileDoc.exists ? (profileDoc.data() || {}) : {};

    const publicConfig = mapWidgetToPublicConfig(widgetData, profileData, widgetId);
    const fallbackCollectedInfo = summarizeHistory(history);
    const safeCollectedInfo = collectedInfo || fallbackCollectedInfo || "Lead qualified via chat";

    const handoffPayload = {
      source: {
        product: "leads.widget",
        widget_id: publicConfig.widgetId,
        client_id: publicConfig.clientId,
        lead_chat_slug: publicConfig.leadChatSlug,
        sent_at: nowIso,
      },
      lead: {
        name,
        phone,
        collected_info: safeCollectedInfo,
      },
      consent: {
        accepted: true,
        accepted_at: nowIso,
        text_version: consentTextVersion,
        text: consentText || publicConfig.consentText || "",
        explicit_response: consentExplicitResponse,
        ip: clientIp,
        user_agent: userAgent,
      },
      history: history
        .filter((item) => item && (item.role === "user" || item.role === "assistant"))
        .slice(-20)
        .map((item) => ({
          role: item.role,
          content: cleanText(item.content || "").slice(0, 1500),
        })),
    };

    const iacloserApiUrl = getIaCloserApiUrl();
    const iacloserApiKey = getIaCloserApiKey();
    const defaultRedirect = sanitizeHttpUrl(
      publicConfig.iacloserRedirectUrl || process.env.IACLOSER_DEFAULT_REDIRECT_URL || "",
    );

    if (!iacloserApiUrl) {
      return res.status(400).json({
        error: "IACLOSER_API_URL is not configured",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let upstreamJson = {};
    let upstreamStatus = 0;
    try {
      const upstream = await fetch(iacloserApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(iacloserApiKey ? { Authorization: `Bearer ${iacloserApiKey}` } : {}),
        },
        body: JSON.stringify(handoffPayload),
        signal: controller.signal,
      });
      upstreamStatus = upstream.status;
      const upstreamText = await upstream.text();
      upstreamJson = safeJsonParse(upstreamText, { raw: upstreamText }) || {};

      if (!upstream.ok) {
        await firestore.collection("lead_handoffs").add({
          widget_id: publicConfig.widgetId,
          client_id: publicConfig.clientId,
          status: "failed",
          upstream_status: upstream.status,
          upstream_response: typeof upstreamJson === "object" ? upstreamJson : { raw: String(upstreamJson || "") },
          payload_preview: {
            name,
            phone,
            collected_info: safeCollectedInfo.slice(0, 500),
          },
          consent: handoffPayload.consent,
          created_at: nowIso,
        });
        return res.status(502).json({
          error: "IACloser handoff failed",
          details: typeof upstreamJson === "object" ? upstreamJson : undefined,
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const upstreamObject = upstreamJson && typeof upstreamJson === "object" ? upstreamJson : {};
    const upstreamLeadId = cleanText(
      String(upstreamObject?.lead_id || upstreamObject?.leadId || upstreamObject?.id || ""),
    );
    const queuedCallInSeconds = parseEtaSeconds(
      upstreamObject?.eta_seconds
        ?? upstreamObject?.etaSeconds
        ?? upstreamObject?.queuedCallInSeconds
        ?? 60,
      60,
    );
    const upstreamRedirect = sanitizeHttpUrl(
      upstreamObject?.redirect_url
      || upstreamObject?.redirectUrl
      || upstreamObject?.landing_url
      || "",
    );
    const redirectUrl = upstreamRedirect || defaultRedirect;

    const handoffRef = await firestore.collection("lead_handoffs").add({
      widget_id: publicConfig.widgetId,
      client_id: publicConfig.clientId,
      status: "sent",
      upstream_status: upstreamStatus,
      upstream_response: typeof upstreamJson === "object" ? upstreamJson : { raw: String(upstreamJson || "") },
      payload_preview: {
        name,
        phone,
        collected_info: safeCollectedInfo.slice(0, 1000),
      },
      consent: handoffPayload.consent,
      redirect_url: redirectUrl || null,
      upstream_lead_id: upstreamLeadId || null,
      eta_seconds: queuedCallInSeconds,
      created_at: nowIso,
    });

    await firestore.collection("leads").add({
      client_id: publicConfig.clientId,
      widget_id: publicConfig.widgetId,
      name,
      phone,
      interest: safeCollectedInfo.slice(0, 1900),
      source: "lead_chat_iacloser",
      status: "handoff_sent",
      created_at: nowIso,
    });

    return res.status(200).json({
      success: true,
      handoffId: handoffRef.id,
      leadId: upstreamLeadId || null,
      lead_id: upstreamLeadId || null,
      redirectUrl: redirectUrl || null,
      redirect_url: redirectUrl || null,
      queuedCallInSeconds,
      etaSeconds: queuedCallInSeconds,
      eta_seconds: queuedCallInSeconds,
    });
  } catch (error) {
    console.error("icloser handoff error", error);
    return res.status(500).json({ error: "Failed to send handoff" });
  }
});

app.post("/api/users/bootstrap", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const uid = decoded.uid;
  const email = (decoded.email || "").toLowerCase();
  const businessName = (req.body?.businessName || "").toString().trim();
  const referredByRaw = req.body?.referredBy || null;
  const accountTypeRaw = (req.body?.accountType || "client").toString().trim().toLowerCase();
  const partnerCodeRaw = req.body?.partnerCode || null;
  const partnerNameRaw = (req.body?.partnerName || businessName || decoded.name || "").toString().trim();
  const inviteCodeRaw = (req.body?.inviteCode || "").toString().trim();
  const now = new Date().toISOString();
  let ipLockRef = null;
  let ipLockCreated = false;
  let profileCreated = false;

  try {
    const profileRef = firestore.collection("profiles").doc(uid);
    const profileSnap = await profileRef.get();
    let created = false;
    let role = "client";
    let partnerId = null;
    let partnerCode = null;

    let referredBy = null;
    if (typeof referredByRaw === "string") {
      const candidate = referredByRaw.trim();
      if (candidate && candidate !== uid) {
        const refSnap = await firestore.collection("profiles").doc(candidate).get();
        if (refSnap.exists) referredBy = candidate;
      }
    }

    let inviteData = null;
    let inviteDocRef = null;
    if (inviteCodeRaw) {
      inviteDocRef = firestore.collection("partner_invites").doc(inviteCodeRaw);
      const inviteSnap = await inviteDocRef.get();
      if (inviteSnap.exists) {
        const rawInvite = inviteSnap.data() || {};
        const inviteEmail = String(rawInvite.email || "").trim().toLowerCase();
        const inviteStatus = String(rawInvite.status || "pending").toLowerCase();
        if (inviteStatus === "pending" && (!inviteEmail || inviteEmail === email)) {
          inviteData = {
            id: inviteSnap.id,
            partner_id: rawInvite.partner_id || null,
            role: normalizePartnerRole(rawInvite.role),
            invited_by: rawInvite.invited_by || null,
          };
        }
      }
    }

    let attributedPartner = null;
    const partnerByCode = await getPartnerByCode(partnerCodeRaw);
    if (partnerByCode && PARTNER_STATUSES.has(String(partnerByCode.status || "active").toLowerCase())) {
      attributedPartner = partnerByCode;
    }

    if (!attributedPartner && referredBy) {
      const refProfileSnap = await firestore.collection("profiles").doc(referredBy).get();
      if (refProfileSnap.exists) {
        const refData = refProfileSnap.data() || {};
        if (refData.partner_id) {
          const pSnap = await firestore.collection("partners").doc(refData.partner_id).get();
          if (pSnap.exists) {
            const candidate = { id: pSnap.id, ...pSnap.data() };
            if (PARTNER_STATUSES.has(String(candidate.status || "active").toLowerCase())) {
              attributedPartner = candidate;
            }
          }
        }
      }
    }

    if (!profileSnap.exists) {
      const ipLock = await acquireSignupIpLock({
        uid,
        clientIp: clientIpFrom(req),
        nowIso: now,
      });
      ipLockRef = ipLock.lockRef;
      ipLockCreated = ipLock.lockCreated;

      created = true;
      const profileData = {
        email: decoded.email || null,
        business_name: businessName,
        created_at: now,
        updated_at: now,
        subscription_status: "trial",
        ai_enabled: false,
        ai_model: "gpt-4o-mini",
        referred_by: referredBy,
        account_type: "client",
        partner_id: null,
        partner_role: null,
        attribution_source: attributedPartner ? "partner_code_or_ref" : null,
        attributed_partner_locked_at: attributedPartner ? now : null,
      };

      if (inviteData?.partner_id) {
        partnerId = inviteData.partner_id;
        role = inviteData.role;

        await firestore.collection("partner_users").doc(uid).set({
          partner_id: partnerId,
          role,
          status: "active",
          email: decoded.email || null,
          invited_by: inviteData.invited_by || null,
          created_at: now,
          updated_at: now,
        }, { merge: true });

        if (inviteDocRef) {
          await inviteDocRef.set({
            status: "accepted",
            accepted_by: uid,
            accepted_at: now,
            updated_at: now,
          }, { merge: true });
        }

        profileData.account_type = "partner_user";
        profileData.partner_id = partnerId;
        profileData.partner_role = role;
        profileData.attribution_source = null;
      } else if (accountTypeRaw === "partner") {
        const partnerCreated = await createOrReusePartner({
          uid,
          email,
          displayName: partnerNameRaw || businessName || "Agency",
          providedCode: partnerCodeRaw,
        });
        partnerId = partnerCreated.partnerId;
        partnerCode = partnerCreated.code;
        role = "partner_admin";

        await firestore.collection("partner_users").doc(uid).set({
          partner_id: partnerId,
          role,
          status: "active",
          email: decoded.email || null,
          created_at: now,
          updated_at: now,
        }, { merge: true });

        profileData.account_type = "partner_user";
        profileData.partner_id = partnerId;
        profileData.partner_role = role;
        profileData.attribution_source = null;
      } else if (attributedPartner?.id) {
        partnerId = attributedPartner.id;
        partnerCode = attributedPartner.code || null;
        profileData.partner_id = partnerId;
      }

      await profileRef.set(profileData);
      profileCreated = true;
    } else {
      const updates = { updated_at: now };
      if (businessName) updates.business_name = businessName;

      const currentProfile = profileSnap.data() || {};
      const existingMembership = await getPartnerMembership(uid);

      if (!currentProfile.partner_id && attributedPartner?.id) {
        updates.partner_id = attributedPartner.id;
        updates.attribution_source = "partner_code_or_ref";
        updates.attributed_partner_locked_at = now;
        partnerId = attributedPartner.id;
        partnerCode = attributedPartner.code || null;
      } else if (currentProfile.partner_id) {
        partnerId = currentProfile.partner_id;
      }

      if (inviteData?.partner_id && !existingMembership) {
        partnerId = inviteData.partner_id;
        role = inviteData.role;

        await firestore.collection("partner_users").doc(uid).set({
          partner_id: partnerId,
          role,
          status: "active",
          email: decoded.email || null,
          invited_by: inviteData.invited_by || null,
          created_at: now,
          updated_at: now,
        }, { merge: true });

        if (inviteDocRef) {
          await inviteDocRef.set({
            status: "accepted",
            accepted_by: uid,
            accepted_at: now,
            updated_at: now,
          }, { merge: true });
        }

        updates.account_type = "partner_user";
        updates.partner_id = partnerId;
        updates.partner_role = role;
        updates.attribution_source = null;
      } else if (accountTypeRaw === "partner" && !existingMembership) {
        const partnerCreated = await createOrReusePartner({
          uid,
          email,
          displayName: partnerNameRaw || currentProfile.business_name || "Agency",
          providedCode: partnerCodeRaw,
        });
        partnerId = partnerCreated.partnerId;
        partnerCode = partnerCreated.code;
        role = "partner_admin";

        await firestore.collection("partner_users").doc(uid).set({
          partner_id: partnerId,
          role,
          status: "active",
          email: decoded.email || null,
          created_at: now,
          updated_at: now,
        }, { merge: true });

        updates.account_type = "partner_user";
        updates.partner_id = partnerId;
        updates.partner_role = role;
        updates.attribution_source = null;
      } else if (existingMembership?.partner_id) {
        role = normalizePartnerRole(existingMembership.role);
        partnerId = existingMembership.partner_id;
      }

      await profileRef.set(updates, { merge: true });
    }

    if (SUPERADMIN_EMAILS.has(email)) {
      await firestore.collection("user_roles").doc(uid).set(
        { role: "superadmin", updated_at: now },
        { merge: true }
      );
      return res.status(200).json({ success: true, role: "superadmin", created });
    }

    if (!isPartnerRole(role)) {
      const membership = await getPartnerMembership(uid);
      if (membership?.partner_id && membership.status !== "suspended") {
        role = normalizePartnerRole(membership.role);
        partnerId = membership.partner_id;
      } else {
        const profileRecoverySnap = await profileRef.get();
        const profileRecovery = profileRecoverySnap.exists ? (profileRecoverySnap.data() || {}) : {};
        const accountType = String(profileRecovery.account_type || "").toLowerCase();
        const recoverablePartnerId = profileRecovery.partner_id || null;
        const recoverableRole = normalizePartnerRole(profileRecovery.partner_role || "partner_admin");

        // Safety net: recover broken partner membership only for agency accounts.
        if ((accountType === "partner_user" || accountType === "partner") && recoverablePartnerId) {
          const partnerSnap = await firestore.collection("partners").doc(recoverablePartnerId).get();
          const partnerStatus = String(partnerSnap.exists ? (partnerSnap.data()?.status || "active") : "missing").toLowerCase();

          if (partnerSnap.exists && partnerStatus !== "suspended") {
            await firestore.collection("partner_users").doc(uid).set({
              partner_id: recoverablePartnerId,
              role: recoverableRole,
              status: "active",
              email: decoded.email || null,
              updated_at: now,
            }, { merge: true });

            role = recoverableRole;
            partnerId = recoverablePartnerId;
          } else {
            role = "client";
          }
        } else {
          role = "client";
        }
      }
    }

    if (partnerId && !partnerCode) {
      const partnerSnap = await firestore.collection("partners").doc(partnerId).get();
      if (partnerSnap.exists) partnerCode = partnerSnap.data()?.code || null;
    }

    return res.status(200).json({
      success: true,
      role,
      created,
      partner_id: partnerId || null,
      partner_code: partnerCode || null,
    });
  } catch (error) {
    if (error?.code === "IP_SIGNUP_LIMIT_REACHED" || error?.httpStatus === 429) {
      return res.status(429).json({ error: "Only one account per IP is allowed" });
    }

    if (ipLockCreated && !profileCreated && ipLockRef) {
      try {
        await ipLockRef.delete();
      } catch (cleanupError) {
        console.error("bootstrap ip lock cleanup error", cleanupError);
      }
    }

    console.error("bootstrap user error", error);
    return res.status(500).json({ error: "Failed to bootstrap user profile" });
  }
});

app.get("/api/affiliates/network", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const uid = decoded.uid;
  const includeInactive = String(req.query?.includeInactive || "0").toLowerCase() === "1";
  const requestedLevels = Number(req.query?.levels || 4);
  const maxLevels = 4;
  const levels = Number.isFinite(requestedLevels) ? Math.min(Math.max(1, requestedLevels), maxLevels) : maxLevels;

  const mapProfile = (id, data) => ({
    id,
    email: data?.email || null,
    display_name: data?.display_name || null,
    business_name: data?.business_name || null,
    subscription_status: data?.subscription_status || "trial",
    plan_type: data?.plan_type || null,
    referred_by: data?.referred_by || null,
    created_at: data?.created_at || null,
  });

  try {
    const myProfileSnap = await firestore.collection("profiles").doc(uid).get();
    const myProfile = myProfileSnap.exists ? myProfileSnap.data() : {};

    let upline = null;
    const uplineId = typeof myProfile?.referred_by === "string" ? myProfile.referred_by.trim() : "";
    if (uplineId) {
      const upSnap = await firestore.collection("profiles").doc(uplineId).get();
      if (upSnap.exists) upline = mapProfile(upSnap.id, upSnap.data());
    }

    const getChildrenOf = async (parentId) => {
      const q = await firestore.collection("profiles").where("referred_by", "==", parentId).get();
      const out = [];
      q.docs.forEach((d) => {
        const data = d.data() || {};
        const status = (data.subscription_status || "trial").toString();
        if (!includeInactive && status !== "active") return;
        out.push(mapProfile(d.id, data));
      });
      return out;
    };

    const levelsOut = [];
    let parents = [uid];
    const seen = new Set([uid]);

    for (let level = 1; level <= levels; level++) {
      if (!parents.length) break;
      const childBuckets = await Promise.all(parents.map((p) => getChildrenOf(p)));
      const children = childBuckets.flat();
      const unique = [];
      const nextParents = [];
      for (const c of children) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        unique.push(c);
        nextParents.push(c.id);
      }
      levelsOut.push({ level, users: unique });
      parents = nextParents;
    }

    return res.status(200).json({
      upline,
      levels: levelsOut,
    });
  } catch (error) {
    console.error("affiliate network error", error);
    return res.status(500).json({ error: "Failed to load affiliate network" });
  }
});

app.post("/api/admin/delete-user", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const callerIsSuperAdmin = await isSuperAdmin(decoded);
    if (!callerIsSuperAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const targetUserId = (req.body?.userId || "").toString().trim();
    if (!targetUserId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const profileRef = firestore.collection("profiles").doc(targetUserId);
    const profileSnap = await profileRef.get();
    let authUserRecord = null;
    try {
      authUserRecord = await firebaseAdmin.auth().getUser(targetUserId);
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
    }

    const targetEmail = String(profileSnap.data()?.email || authUserRecord?.email || "").toLowerCase();
    const targetRoleSnap = await firestore.collection("user_roles").doc(targetUserId).get();
    const targetRole = (targetRoleSnap.data()?.role || "").toLowerCase();

    if (targetUserId === decoded.uid || SUPERADMIN_EMAILS.has(targetEmail) || targetRole === "superadmin") {
      return res.status(403).json({ error: "Protected superadmin account cannot be deleted" });
    }

    const configSnap = await firestore
      .collection("widget_configs")
      .where("user_id", "==", targetUserId)
      .get();
    const paymentsSnap = await firestore
      .collection("payments")
      .where("user_id", "==", targetUserId)
      .get();
    const visitsSnap = await firestore
      .collection("visits")
      .where("client_id", "==", targetUserId)
      .get();
    const leadsSnap = await firestore
      .collection("leads")
      .where("client_id", "==", targetUserId)
      .get();

    const batch = firestore.batch();
    batch.delete(profileRef);
    batch.delete(firestore.collection("user_roles").doc(targetUserId));
    batch.delete(firestore.collection("partner_users").doc(targetUserId));

    configSnap.docs.forEach((d) => batch.delete(d.ref));
    paymentsSnap.docs.forEach((d) => batch.delete(d.ref));
    visitsSnap.docs.forEach((d) => batch.delete(d.ref));
    leadsSnap.docs.forEach((d) => batch.delete(d.ref));

    let authDeleted = false;
    try {
      await firebaseAdmin.auth().deleteUser(targetUserId);
      authDeleted = true;
    } catch (error) {
      if (error?.code !== "auth/user-not-found") throw error;
    }

    await batch.commit();

    return res.status(200).json({ success: true, auth_deleted: authDeleted });
  } catch (error) {
    console.error("admin delete user error", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  const { orderID, user_id, plan_type } = req.body || {};
  if (!orderID) {
    return res.status(400).json({ error: "Missing orderID" });
  }

  const decoded = await decodeTokenIfPresent(req);
  const insecureAllowed = String(process.env.ALLOW_INSECURE_VERIFY_PAYMENT || "false").toLowerCase() === "true";

  let targetUserId = decoded?.uid || null;
  if (!targetUserId && insecureAllowed) {
    targetUserId = user_id || null;
  }
  if (decoded?.uid && user_id && decoded.uid !== user_id) {
    const callerIsSuperAdmin = await isSuperAdmin(decoded);
    if (!callerIsSuperAdmin) {
      return res.status(403).json({ error: "Forbidden. Cannot verify payments for another user." });
    }
    targetUserId = user_id;
  }

  if (!targetUserId) {
    return res.status(401).json({ error: "Unauthorized. Missing valid Firebase token." });
  }

  const paypalClientId = (process.env.PAYPAL_CLIENT_ID || "").trim();
  const paypalClientSecret = (process.env.PAYPAL_CLIENT_SECRET || "").trim();
  const paypalEnv = (process.env.PAYPAL_ENV || "live").trim().toLowerCase();

  if (!paypalClientId || !paypalClientSecret) {
    return res.status(400).json({ error: "Missing PAYPAL credentials" });
  }

  const paypalApi = paypalEnv === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

  try {
    const existing = await firestore
      .collection("payments")
      .where("paypal_order_id", "==", orderID)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(200).json({ success: true, idempotent: true });
    }

    const auth = Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString("base64");
    const tokenResponse = await fetch(`${paypalApi}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      return res.status(500).json({ error: tokenData?.error_description || "Failed PayPal auth" });
    }

    const accessToken = tokenData.access_token;

    const orderResponse = await fetch(`${paypalApi}/v2/checkout/orders/${orderID}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const orderData = await orderResponse.json();
    if (!orderResponse.ok) {
      return res.status(500).json({ error: orderData?.message || "Failed to fetch order" });
    }

    if (!["COMPLETED", "APPROVED"].includes(orderData.status)) {
      return res.status(400).json({ error: `Invalid order status: ${orderData.status}` });
    }

    const amount = orderData?.purchase_units?.[0]?.amount?.value || "0";
    const currency = orderData?.purchase_units?.[0]?.amount?.currency_code || "USD";
    const normalizedPlanType = String(plan_type || "pro").toLowerCase() === "plus" ? "plus" : "pro";

    const profileSnap = await firestore.collection("profiles").doc(targetUserId).get();
    const profileData = profileSnap.exists ? profileSnap.data() || {} : {};
    const partnerId = profileData?.partner_id || null;

    const paymentRef = await firestore.collection("payments").add({
      user_id: targetUserId,
      amount,
      currency,
      payment_method: "PayPal",
      description: "Lead Widget Subscription",
      status: "completed",
      plan_type: normalizedPlanType,
      billing_cycle_type: "subscription",
      partner_id: partnerId,
      paypal_order_id: orderID,
      payer_email: orderData?.payer?.email_address || "unknown",
      verified_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      verified_by_server: true,
    });

    await firestore.collection("profiles").doc(targetUserId).set({
      subscription_status: "active",
      plan_type: normalizedPlanType,
      next_renewal_at: addDaysIso(new Date().toISOString(), 30),
      trial_ends_at: null,
      updated_at: new Date().toISOString(),
    }, { merge: true });

    await createCommissionLedgerForPayment({
      paymentId: paymentRef.id,
      userId: targetUserId,
      partnerId,
      amount,
      currency,
      planType: normalizedPlanType,
      paymentMethod: "PayPal",
      paymentStatus: "completed",
      paymentDate: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, message: "Payment verified and subscription activated" });
  } catch (error) {
    console.error("verify-payment error", error);
    return res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

app.get("/api/crm/contacts", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const stage = cleanText(req.query?.stage || "").toLowerCase();
  const source = trimToMaxLength(req.query?.source || "", 80).toLowerCase();
  const search = normalizeComparableText(req.query?.q || "");
  const requestedLimit = Number(req.query?.limit || 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(1, Math.round(requestedLimit)), MAX_CRM_CONTACTS_LIST_LIMIT)
    : 100;

  if (stage && stage !== "all" && !CRM_STAGES.has(stage)) {
    return res.status(400).json({ error: "stage must be new, contacted, qualified, won or lost" });
  }

  try {
    const snap = await firestore.collection("crm_contacts").where("client_id", "==", decoded.uid).get();
    const contacts = sortCrmContacts(
      snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) })),
    ).filter((contact) => {
      if (stage && stage !== "all" && normalizeCrmStage(contact.stage) !== stage) return false;
      if (source && normalizeComparableText(contact.source || "") !== normalizeComparableText(source)) return false;
      if (!search) return true;

      const haystack = [
        contact.name,
        contact.phone,
        contact.email,
        contact.interest,
        contact.notes,
      ].map((value) => normalizeComparableText(value || ""));

      return haystack.some((value) => value.includes(search));
    });

    return res.status(200).json({
      contacts: contacts.slice(0, limit).map((contact) => mapCrmContactToResponse(contact)),
      total: contacts.length,
    });
  } catch (error) {
    console.error("crm contacts list error", error);
    return res.status(500).json({ error: "Failed to load CRM contacts" });
  }
});

app.get("/api/crm/contacts/:contactId", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const contactId = trimToMaxLength(req.params?.contactId || "", 140);
  if (!contactId) return res.status(400).json({ error: "contactId is required" });

  try {
    const contactSnap = await firestore.collection("crm_contacts").doc(contactId).get();
    if (!contactSnap.exists) {
      return res.status(404).json({ error: "CRM contact not found" });
    }

    const contact = { id: contactSnap.id, ...(contactSnap.data() || {}) };
    if (trimToMaxLength(contact.client_id || "", 140) !== decoded.uid) {
      return res.status(404).json({ error: "CRM contact not found" });
    }

    return res.status(200).json({ contact: mapCrmContactToResponse(contact) });
  } catch (error) {
    console.error("crm contact get error", error);
    return res.status(500).json({ error: "Failed to load CRM contact" });
  }
});

app.post("/api/crm/contacts", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const name = trimToMaxLength(req.body?.name || "", 180);
  const rawPhone = req.body?.phone;
  const rawEmail = req.body?.email;
  const interest = trimToMaxLength(req.body?.interest || "", 300);
  const notes = trimToMaxLength(req.body?.notes || "", 1600);
  const requestedStage = cleanText(req.body?.stage || "");
  const requestedSource = trimToMaxLength(req.body?.source || "", 80);
  const phone = sanitizeCrmPhone(rawPhone);
  const email = sanitizeCrmEmail(rawEmail);

  if (!name) return res.status(400).json({ error: "name is required" });
  if (rawPhone != null && phone == null) {
    return res.status(400).json({ error: "phone must be a valid phone number" });
  }
  if (rawEmail != null && email == null) {
    return res.status(400).json({ error: "email must be a valid email address" });
  }
  if (requestedStage && !CRM_STAGES.has(requestedStage.toLowerCase())) {
    return res.status(400).json({ error: "stage must be new, contacted, qualified, won or lost" });
  }

  try {
    let responsePayload = null;

    await firestore.runTransaction(async (tx) => {
      const contactsSnap = await tx.get(
        firestore.collection("crm_contacts").where("client_id", "==", decoded.uid).limit(5000),
      );

      const normalizedPhone = normalizePhoneForCrmDedupe(phone || "");
      const normalizedEmail = normalizeEmailForCrmDedupe(email || "");
      let matchedDoc = null;

      for (const docSnap of contactsSnap.docs) {
        const row = docSnap.data() || {};
        const rowPhone = normalizePhoneForCrmDedupe(row.dedupe_phone || row.phone || "");
        const rowEmail = normalizeEmailForCrmDedupe(row.dedupe_email || row.email || "");

        if (normalizedPhone && rowPhone === normalizedPhone) {
          matchedDoc = docSnap;
          break;
        }
        if (normalizedEmail && rowEmail === normalizedEmail) {
          matchedDoc = docSnap;
          break;
        }
      }

      const nowIso = new Date().toISOString();
      const incomingRecord = {
        client_id: decoded.uid,
        name,
        phone: phone || "",
        email: email || "",
        interest,
        stage: normalizeCrmStage(requestedStage, "new"),
        source: requestedSource || CRM_MANUAL_SOURCE,
        notes,
        created_at: nowIso,
        updated_at: nowIso,
        last_activity_at: nowIso,
        dedupe_phone: normalizedPhone,
        dedupe_email: normalizedEmail,
      };

      if (!matchedDoc) {
        const contactRef = firestore.collection("crm_contacts").doc();
        tx.set(contactRef, incomingRecord);
        tx.set(
          firestore.collection("activity_events").doc(),
          {
            client_id: decoded.uid,
            entity_type: "contact",
            entity_id: contactRef.id,
            type: "contact_created",
            payload_json: {
              reason: "crm_manual_create",
              source: incomingRecord.source,
            },
            created_at: nowIso,
            created_by: decoded.uid,
          },
          { merge: true },
        );

        responsePayload = {
          success: true,
          contact: mapCrmContactToResponse({ id: contactRef.id, ...incomingRecord }),
          action: "created",
        };
        return;
      }

      const mergedContact = mergeManualCrmContactData(matchedDoc.data() || {}, incomingRecord);
      tx.set(matchedDoc.ref, mergedContact, { merge: true });
      tx.set(
        firestore.collection("activity_events").doc(),
        {
          client_id: decoded.uid,
          entity_type: "contact",
          entity_id: matchedDoc.id,
          type: "dedupe_merge",
          payload_json: {
            reason: "crm_manual_create",
            source: mergedContact.source,
          },
          created_at: nowIso,
          created_by: decoded.uid,
        },
        { merge: true },
      );

      responsePayload = {
        success: true,
        contact: mapCrmContactToResponse({ id: matchedDoc.id, ...mergedContact }),
        action: "merged",
      };
    });

    return res.status(200).json(responsePayload || { success: true });
  } catch (error) {
    console.error("crm contact create error", error);
    return res.status(500).json({ error: "Failed to create CRM contact" });
  }
});

app.patch("/api/crm/contacts/:contactId", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const contactId = trimToMaxLength(req.params?.contactId || "", 140);
  if (!contactId) return res.status(400).json({ error: "contactId is required" });

  const providedFields = ["name", "phone", "email", "interest", "stage", "notes"]
    .filter((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field));
  if (providedFields.length === 0) {
    return res.status(400).json({ error: "At least one CRM contact field must be provided" });
  }

  const rawName = Object.prototype.hasOwnProperty.call(req.body || {}, "name")
    ? trimToMaxLength(req.body?.name || "", 180)
    : null;
  const rawPhonePresent = Object.prototype.hasOwnProperty.call(req.body || {}, "phone");
  const rawEmailPresent = Object.prototype.hasOwnProperty.call(req.body || {}, "email");
  const rawInterest = Object.prototype.hasOwnProperty.call(req.body || {}, "interest")
    ? trimToMaxLength(req.body?.interest || "", 300)
    : null;
  const rawNotes = Object.prototype.hasOwnProperty.call(req.body || {}, "notes")
    ? trimToMaxLength(req.body?.notes || "", 1600)
    : null;
  const rawStage = Object.prototype.hasOwnProperty.call(req.body || {}, "stage")
    ? cleanText(req.body?.stage || "").toLowerCase()
    : null;
  const nextPhone = rawPhonePresent ? sanitizeCrmPhone(req.body?.phone) : null;
  const nextEmail = rawEmailPresent ? sanitizeCrmEmail(req.body?.email) : null;

  if (rawName != null && !rawName) return res.status(400).json({ error: "name cannot be empty" });
  if (rawPhonePresent && nextPhone == null) {
    return res.status(400).json({ error: "phone must be a valid phone number" });
  }
  if (rawEmailPresent && nextEmail == null) {
    return res.status(400).json({ error: "email must be a valid email address" });
  }
  if (rawStage != null && !CRM_STAGES.has(rawStage)) {
    return res.status(400).json({ error: "stage must be new, contacted, qualified, won or lost" });
  }

  try {
    let responsePayload = null;

    await firestore.runTransaction(async (tx) => {
      const contactRef = firestore.collection("crm_contacts").doc(contactId);
      const contactSnap = await tx.get(contactRef);
      if (!contactSnap.exists) {
        const error = new Error("CRM contact not found");
        error.httpStatus = 404;
        throw error;
      }

      const currentContact = { id: contactSnap.id, ...(contactSnap.data() || {}) };
      if (trimToMaxLength(currentContact.client_id || "", 140) !== decoded.uid) {
        const error = new Error("CRM contact not found");
        error.httpStatus = 404;
        throw error;
      }

      const desiredPhone = rawPhonePresent
        ? normalizePhoneForCrmDedupe(nextPhone || "")
        : normalizePhoneForCrmDedupe(currentContact.dedupe_phone || currentContact.phone || "");
      const desiredEmail = rawEmailPresent
        ? normalizeEmailForCrmDedupe(nextEmail || "")
        : normalizeEmailForCrmDedupe(currentContact.dedupe_email || currentContact.email || "");

      if (desiredPhone || desiredEmail) {
        const contactsSnap = await tx.get(
          firestore.collection("crm_contacts").where("client_id", "==", decoded.uid).limit(5000),
        );
        for (const docSnap of contactsSnap.docs) {
          if (docSnap.id === contactId) continue;
          const row = docSnap.data() || {};
          const rowPhone = normalizePhoneForCrmDedupe(row.dedupe_phone || row.phone || "");
          const rowEmail = normalizeEmailForCrmDedupe(row.dedupe_email || row.email || "");
          if (desiredPhone && rowPhone === desiredPhone) {
            const error = new Error("Another CRM contact already uses that phone number");
            error.httpStatus = 409;
            throw error;
          }
          if (desiredEmail && rowEmail === desiredEmail) {
            const error = new Error("Another CRM contact already uses that email address");
            error.httpStatus = 409;
            throw error;
          }
        }
      }

      const nowIso = new Date().toISOString();
      const updatedContact = {
        ...currentContact,
        name: rawName ?? currentContact.name ?? "Sin nombre",
        phone: rawPhonePresent ? (nextPhone || "") : trimToMaxLength(currentContact.phone || "", 60),
        email: rawEmailPresent ? (nextEmail || "") : normalizeEmailForCrmDedupe(currentContact.email || ""),
        interest: rawInterest ?? trimToMaxLength(currentContact.interest || "", 300),
        stage: rawStage != null ? rawStage : normalizeCrmStage(currentContact.stage, "new"),
        notes: rawNotes ?? trimToMaxLength(currentContact.notes || "", 1600),
        updated_at: nowIso,
        last_activity_at: nowIso,
      };
      updatedContact.dedupe_phone = normalizePhoneForCrmDedupe(updatedContact.phone || "");
      updatedContact.dedupe_email = normalizeEmailForCrmDedupe(updatedContact.email || "");

      tx.set(contactRef, updatedContact, { merge: true });
      tx.set(
        firestore.collection("activity_events").doc(),
        {
          client_id: decoded.uid,
          entity_type: "contact",
          entity_id: contactId,
          type: "contact_updated",
          payload_json: {
            fields: providedFields,
          },
          created_at: nowIso,
          created_by: decoded.uid,
        },
        { merge: true },
      );

      responsePayload = {
        success: true,
        contact: mapCrmContactToResponse({ id: contactId, ...updatedContact }),
      };
    });

    return res.status(200).json(responsePayload || { success: true });
  } catch (error) {
    console.error("crm contact patch error", error);
    const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
    if (status !== 500) {
      return res.status(status).json({ error: error?.message || "Failed to update CRM contact" });
    }
    return res.status(500).json({ error: "Failed to update CRM contact" });
  }
});

app.post("/api/acquisition/search", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const category = trimToMaxLength(req.body?.category || "", 160);
  const city = trimToMaxLength(req.body?.city || "", 120);
  const country = trimToMaxLength(req.body?.country || "", 120);
  const minScore = parseOptionalMinScore(req.body?.minScore);

  if (!category) return res.status(400).json({ error: "category is required" });
  if (!city) return res.status(400).json({ error: "city is required" });
  if (req.body?.minScore != null && minScore == null) {
    return res.status(400).json({ error: "minScore must be a number between 0 and 100" });
  }

  try {
    const places = await fetchGoogleAcquisitionPlaces({ category, city, country });
    const existingProspects = await listAcquisitionProspectsByClient(decoded.uid);
    const existingByExternalId = new Map();
    existingProspects.forEach((record) => {
      const externalId = trimToMaxLength(record.external_id || "", 180);
      if (externalId) existingByExternalId.set(externalId, record);
    });

    const nowIso = new Date().toISOString();
    const batch = firestore.batch();
    const normalizedRecords = [];

    places.forEach((place) => {
      const externalId = trimToMaxLength(place?.id || "", 180);
      if (!externalId) return;

      const existingRecord = existingByExternalId.get(externalId) || null;
      const normalizedRecord = normalizeAcquisitionProspectRecord(
        place,
        existingRecord,
        { category, city, country },
        decoded.uid,
      );
      normalizedRecord.updated_at = nowIso;
      normalizedRecord.created_at = existingRecord?.created_at || nowIso;

      batch.set(
        firestore.collection("acquisition_prospects").doc(normalizedRecord.id),
        normalizedRecord,
        { merge: true },
      );
      normalizedRecords.push(normalizedRecord);
    });

    if (normalizedRecords.length > 0) {
      await batch.commit();
    }

    const prospects = normalizedRecords
      .filter((record) => prospectMatchesAcquisitionFilters(record, { minScore }))
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .map((record) => mapAcquisitionProspectToResponse(record));

    return res.status(200).json({ prospects });
  } catch (error) {
    console.error("acquisition search error", error);
    const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
    if (error?.code === "ACQUISITION_NOT_CONFIGURED") {
      return res.status(500).json({ error: "Acquisition search is not configured" });
    }
    return res.status(status).json({ error: "Unable to search acquisition prospects right now" });
  }
});

app.get("/api/acquisition/prospects", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const statusFilter = cleanText(req.query?.status || "").toLowerCase();
  const category = trimToMaxLength(req.query?.category || "", 160);
  const city = trimToMaxLength(req.query?.city || "", 120);
  const country = trimToMaxLength(req.query?.country || "", 120);
  const minScore = parseOptionalMinScore(req.query?.minScore);

  if (statusFilter && statusFilter !== "all" && !ACQUISITION_STATUSES.has(statusFilter)) {
    return res.status(400).json({ error: "status must be pending, approved or discarded" });
  }
  if (req.query?.minScore != null && String(req.query.minScore).trim() !== "" && minScore == null) {
    return res.status(400).json({ error: "minScore must be a number between 0 and 100" });
  }

  try {
    const prospects = await listAcquisitionProspectsByClient(decoded.uid);
    const filtered = prospects
      .filter((record) => prospectMatchesAcquisitionFilters(record, {
        status: statusFilter,
        category,
        city,
        country,
        minScore,
      }))
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .map((record) => mapAcquisitionProspectToResponse(record));

    return res.status(200).json({ prospects: filtered });
  } catch (error) {
    console.error("acquisition prospects list error", error);
    return res.status(500).json({ error: "Failed to load acquisition prospects" });
  }
});

app.patch("/api/acquisition/prospects", async (req, res) => {
  const decoded = await requireClientAuth(req, res);
  if (!decoded?.uid) return;

  const prospectId = trimToMaxLength(req.body?.id || "", 140);
  const nextStatus = cleanText(req.body?.status || "").toLowerCase();
  if (!prospectId) return res.status(400).json({ error: "id is required" });
  if (!ACQUISITION_OPERATION_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: "status must be approved or discarded" });
  }

  try {
    let responsePayload = null;

    await firestore.runTransaction(async (tx) => {
      const prospectRef = firestore.collection("acquisition_prospects").doc(prospectId);
      const prospectSnap = await tx.get(prospectRef);
      if (!prospectSnap.exists) {
        const error = new Error("Prospect not found");
        error.httpStatus = 404;
        throw error;
      }

      const currentProspect = { id: prospectSnap.id, ...(prospectSnap.data() || {}) };
      if (trimToMaxLength(currentProspect.client_id || "", 140) !== decoded.uid) {
        const error = new Error("Prospect not found");
        error.httpStatus = 404;
        throw error;
      }

      const currentStatus = normalizeAcquisitionStatus(currentProspect.status);
      if (currentStatus === "approved" && nextStatus === "discarded") {
        const error = new Error("Approved prospects cannot be discarded");
        error.httpStatus = 400;
        throw error;
      }

      const nowIso = new Date().toISOString();
      let crmResult = {
        crmContactId: trimToMaxLength(currentProspect.crm_contact_id || "", 140) || null,
        action: "noop",
      };
      let updatedProspect = {
        ...currentProspect,
        status: nextStatus,
        updated_at: nowIso,
      };

      if (nextStatus === "approved") {
        crmResult = await upsertCrmContactFromAcquisitionProspectTx(tx, updatedProspect, decoded.uid);
        updatedProspect = {
          ...updatedProspect,
          crm_contact_id: crmResult.crmContactId,
        };
      }

      tx.set(prospectRef, updatedProspect, { merge: true });
      responsePayload = {
        success: true,
        prospect: mapAcquisitionProspectToResponse(updatedProspect),
        crmContactId: updatedProspect.crm_contact_id || null,
        crm_contact_id: updatedProspect.crm_contact_id || null,
        action: crmResult.action,
      };
    });

    return res.status(200).json(responsePayload || { success: true });
  } catch (error) {
    console.error("acquisition prospect patch error", error);
    const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 500;
    if (status !== 500) {
      return res.status(status).json({ error: error?.message || "Failed to update acquisition prospect" });
    }
    return res.status(500).json({ error: "Failed to update acquisition prospect" });
  }
});

app.post("/api/admin/payments/:paymentId/verify", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });

  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const paymentId = String(req.params?.paymentId || "").trim();
  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });
  if (!["verified", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status. Use verified or rejected." });
  }

  try {
    const paymentRef = firestore.collection("payments").doc(paymentId);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) return res.status(404).json({ error: "Payment not found" });

    const payment = paymentSnap.data() || {};
    const nowIso = new Date().toISOString();
    const normalizedPlanType = String(payment.plan_type || req.body?.plan_type || "pro").toLowerCase() === "plus" ? "plus" : "pro";

    const profileSnap = await firestore.collection("profiles").doc(payment.user_id).get();
    const profile = profileSnap.exists ? profileSnap.data() || {} : {};
    const partnerId = payment.partner_id || profile.partner_id || null;

    await paymentRef.set({
      status,
      plan_type: normalizedPlanType,
      partner_id: partnerId,
      verified_at: nowIso,
      verified_by: decoded.uid,
      updated_at: nowIso,
    }, { merge: true });

    if (status === "verified" && payment.user_id) {
      await firestore.collection("profiles").doc(payment.user_id).set({
        subscription_status: "active",
        plan_type: normalizedPlanType,
        next_renewal_at: addDaysIso(nowIso, 30),
        trial_ends_at: null,
        partner_id: partnerId || null,
        updated_at: nowIso,
      }, { merge: true });

      await createCommissionLedgerForPayment({
        paymentId,
        userId: payment.user_id,
        partnerId,
        amount: payment.amount,
        currency: payment.currency || "PEN",
        planType: normalizedPlanType,
        paymentMethod: payment.payment_method || "Yape/Plin",
        paymentStatus: "verified",
        paymentDate: nowIso,
      });
    }

    return res.status(200).json({ success: true, status });
  } catch (error) {
    console.error("admin verify payment error", error);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
});

app.get("/api/partners/me", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: false });
  if (!authCtx) return;

  try {
    const partnerSnap = await firestore.collection("partners").doc(authCtx.partnerId).get();
    if (!partnerSnap.exists) return res.status(404).json({ error: "Partner not found" });
    const partner = partnerSnap.data() || {};

    return res.status(200).json({
      partner: {
        id: partnerSnap.id,
        name: partner.name || "Partner",
        code: partner.code || null,
        status: partner.status || "active",
        commission_first_rate: safeNumber(partner.commission_first_rate, 0.5),
        commission_recurring_rate: safeNumber(partner.commission_recurring_rate, 0.3),
        payout_method: partner.payout_method || null,
        branding: partner.branding || {},
      },
      user: {
        uid: authCtx.uid,
        role: authCtx.role,
        email: authCtx.decoded?.email || null,
      },
    });
  } catch (error) {
    console.error("partners/me error", error);
    return res.status(500).json({ error: "Failed to load partner profile" });
  }
});

app.get("/api/partners/overview", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;

  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    await ensureManualPlusCommissionRowsForPartner(partnerId);
    const clientsSnap = await firestore.collection("profiles").where("partner_id", "==", partnerId).get();
    const clients = clientsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const activeClients = clients.filter((c) => String(c.subscription_status || "").toLowerCase() === "active");

    const ledgerSnap = await firestore.collection("commission_ledger").where("partner_id", "==", partnerId).get();
    const ledger = ledgerSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const pendingAmount = roundCurrency(ledger
      .filter((l) => String(l.status || "").toLowerCase() === "pending")
      .reduce((sum, l) => sum + safeNumber(l.commission_amount, 0), 0));
    const paidAmount = roundCurrency(ledger
      .filter((l) => String(l.status || "").toLowerCase() === "paid")
      .reduce((sum, l) => sum + safeNumber(l.commission_amount, 0), 0));

    return res.status(200).json({
      kpis: {
        clients_total: clients.length,
        clients_active: activeClients.length,
        commissions_pending: pendingAmount,
        commissions_paid: paidAmount,
      },
    });
  } catch (error) {
    console.error("partners/overview error", error);
    return res.status(500).json({ error: "Failed to load overview" });
  }
});

app.get("/api/partners/clients", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;

  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const clientsSnap = await firestore.collection("profiles").where("partner_id", "==", partnerId).get();
    const paymentsSnap = await firestore.collection("payments").where("partner_id", "==", partnerId).get();
    const latestPaidAtByUser = new Map();
    paymentsSnap.docs.forEach((docSnap) => {
      const payment = docSnap.data() || {};
      const status = String(payment.status || "").toLowerCase();
      if (!["completed", "verified", "active"].includes(status)) return;
      const userId = String(payment.user_id || "").trim();
      if (!userId) return;
      const paidAt = String(payment.verified_at || payment.created_at || "").trim();
      if (!paidAt) return;
      const currentLatest = latestPaidAtByUser.get(userId);
      if (!currentLatest || paidAt > currentLatest) {
        latestPaidAtByUser.set(userId, paidAt);
      }
    });

    const clients = clientsSnap.docs.map((d) => {
      const data = d.data() || {};
      const subscriptionStatus = String(data.subscription_status || "trial").toLowerCase();
      const explicitRenewal = data.next_renewal_at || null;
      const latestPaidAt = latestPaidAtByUser.get(d.id) || null;
      const fallbackBaseDate = latestPaidAt || data.updated_at || data.created_at || null;
      const derivedRenewal = explicitRenewal || (
        subscriptionStatus === "active"
          ? addDaysIso(fallbackBaseDate, 30)
          : null
      );
      return {
        id: d.id,
        email: data.email || null,
        business_name: data.business_name || null,
        subscription_status: data.subscription_status || "trial",
        plan_type: data.plan_type || "pro",
        created_at: data.created_at || null,
        trial_ends_at: data.trial_ends_at || null,
        next_renewal_at: derivedRenewal,
      };
    });

    return res.status(200).json({ clients });
  } catch (error) {
    console.error("partners/clients error", error);
    return res.status(500).json({ error: "Failed to load clients" });
  }
});

app.post("/api/partners/checkout-links", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: false });
  if (!authCtx) return;

  const { utm_source, utm_medium, utm_campaign, draft_id } = req.body || {};

  try {
    const partnerSnap = await firestore.collection("partners").doc(authCtx.partnerId).get();
    if (!partnerSnap.exists) return res.status(404).json({ error: "Partner not found" });
    const partner = partnerSnap.data() || {};
    const partnerCode = partner.code || makeId("partner");
    const checkoutUrl = buildPartnerCheckoutUrl(req, {
      account: "client",
      partner_code: partnerCode,
      utm_source: utm_source || "partner",
      utm_medium: utm_medium || "referral",
      utm_campaign: utm_campaign || null,
      draft: draft_id || null,
    });

    const nowIso = new Date().toISOString();
    const ref = await firestore.collection("partner_checkout_links").add({
      partner_id: authCtx.partnerId,
      partner_code: partnerCode,
      url: checkoutUrl,
      utm_source: utm_source || "partner",
      utm_medium: utm_medium || "referral",
      utm_campaign: utm_campaign || "",
      draft_id: draft_id || null,
      created_by: authCtx.uid,
      created_at: nowIso,
    });

    return res.status(200).json({ id: ref.id, url: checkoutUrl, partner_code: partnerCode });
  } catch (error) {
    console.error("partners/checkout-links create error", error);
    return res.status(500).json({ error: "Failed to create checkout link" });
  }
});

app.get("/api/partners/checkout-links", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_checkout_links").where("partner_id", "==", partnerId).get();
    const links = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return res.status(200).json({ links });
  } catch (error) {
    console.error("partners/checkout-links list error", error);
    return res.status(500).json({ error: "Failed to load checkout links" });
  }
});

app.post("/api/partners/leads", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: false });
  if (!authCtx) return;

  const { name, email, phone, notes, stage } = req.body || {};
  const cleanName = cleanText(name);
  if (!cleanName) return res.status(400).json({ error: "Lead name is required" });

  try {
    const nowIso = new Date().toISOString();
    const ref = await firestore.collection("partner_leads").add({
      partner_id: authCtx.partnerId,
      name: cleanName,
      email: cleanText(email) || null,
      phone: cleanText(phone) || null,
      notes: cleanText(notes) || "",
      stage: cleanText(stage) || "new",
      source: "partner_dashboard",
      created_by: authCtx.uid,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return res.status(200).json({ id: ref.id, success: true });
  } catch (error) {
    console.error("partners/leads create error", error);
    return res.status(500).json({ error: "Failed to create lead" });
  }
});

app.get("/api/partners/leads", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_leads").where("partner_id", "==", partnerId).get();
    const leads = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return res.status(200).json({ leads });
  } catch (error) {
    console.error("partners/leads list error", error);
    return res.status(500).json({ error: "Failed to load leads" });
  }
});

app.post("/api/partners/drafts", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: false });
  if (!authCtx) return;

  const { business_name, email, plan_type, notes } = req.body || {};
  const draftName = cleanText(business_name);
  if (!draftName) return res.status(400).json({ error: "Business name is required" });
  const normalizedPlanType = String(plan_type || "pro").toLowerCase() === "plus" ? "plus" : "pro";

  try {
    const partnerSnap = await firestore.collection("partners").doc(authCtx.partnerId).get();
    const partnerCode = partnerSnap.exists ? partnerSnap.data()?.code : null;
    const nowIso = new Date().toISOString();
    const draftRef = firestore.collection("partner_client_drafts").doc();
    const checkoutUrl = buildPartnerCheckoutUrl(req, {
      account: "client",
      partner_code: partnerCode,
      draft: draftRef.id,
      plan: normalizedPlanType,
      lead_email: cleanText(email) || null,
    });

    await draftRef.set({
      partner_id: authCtx.partnerId,
      business_name: draftName,
      email: cleanText(email) || null,
      notes: cleanText(notes) || "",
      plan_type: normalizedPlanType,
      status: "draft",
      checkout_url: checkoutUrl,
      created_by: authCtx.uid,
      created_at: nowIso,
      updated_at: nowIso,
    });

    return res.status(200).json({ id: draftRef.id, checkout_url: checkoutUrl, success: true });
  } catch (error) {
    console.error("partners/drafts create error", error);
    return res.status(500).json({ error: "Failed to create draft" });
  }
});

app.get("/api/partners/drafts", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_client_drafts").where("partner_id", "==", partnerId).get();
    const drafts = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return res.status(200).json({ drafts });
  } catch (error) {
    console.error("partners/drafts list error", error);
    return res.status(500).json({ error: "Failed to load drafts" });
  }
});

app.get("/api/partners/branding", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const partnerSnap = await firestore.collection("partners").doc(partnerId).get();
    if (!partnerSnap.exists) return res.status(404).json({ error: "Partner not found" });
    const partner = partnerSnap.data() || {};
    return res.status(200).json({ branding: partner.branding || {}, partner_name: partner.name || "Partner" });
  } catch (error) {
    console.error("partners/branding get error", error);
    return res.status(500).json({ error: "Failed to load branding settings" });
  }
});

app.put("/api/partners/branding", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: true, allowSuperAdmin: false });
  if (!authCtx) return;

  const brandingText = cleanText(
    req.body?.branding_text || req.body?.agency_name || "",
  ).slice(0, 120);
  const brandingLink = sanitizeHttpUrl(
    req.body?.branding_link || req.body?.cta_url || "",
    { maxLength: 500 },
  );
  const nowIso = new Date().toISOString();

  try {
    await firestore.collection("partners").doc(authCtx.partnerId).set({
      branding: {
        branding_text: brandingText || "",
        branding_link: brandingLink || "",
        // Compatibilidad de lecturas legacy:
        agency_name: brandingText || "",
        cta_url: brandingLink || "",
      },
      updated_at: nowIso,
    }, { merge: true });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("partners/branding update error", error);
    return res.status(500).json({ error: "Failed to update branding settings" });
  }
});

app.post("/api/partners/tickets", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: false });
  if (!authCtx) return;

  const subject = cleanText(req.body?.subject).slice(0, 140);
  const description = cleanText(req.body?.description).slice(0, 2000);
  const clientUserId = cleanText(req.body?.client_user_id);
  if (!subject || !description) return res.status(400).json({ error: "Subject and description are required" });

  try {
    const nowIso = new Date().toISOString();
    const ref = await firestore.collection("partner_tickets").add({
      partner_id: authCtx.partnerId,
      client_user_id: clientUserId || null,
      subject,
      description,
      status: "open",
      created_by: authCtx.uid,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return res.status(200).json({ id: ref.id, success: true });
  } catch (error) {
    console.error("partners/tickets create error", error);
    return res.status(500).json({ error: "Failed to create ticket" });
  }
});

app.get("/api/partners/tickets", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_tickets").where("partner_id", "==", partnerId).get();
    const tickets = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return res.status(200).json({ tickets });
  } catch (error) {
    console.error("partners/tickets list error", error);
    return res.status(500).json({ error: "Failed to load tickets" });
  }
});

app.put("/api/partners/payout-method", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: true, allowSuperAdmin: false });
  if (!authCtx) return;

  const method = String(req.body?.method || "").trim().toLowerCase();
  const account = cleanText(req.body?.account).slice(0, 120);
  const holderName = cleanText(req.body?.holder_name).slice(0, 120);
  if (!["yape", "plin", "cci"].includes(method)) {
    return res.status(400).json({ error: "Invalid payout method. Use yape, plin or cci." });
  }
  if (!account) return res.status(400).json({ error: "Account is required" });

  try {
    await firestore.collection("partners").doc(authCtx.partnerId).set({
      payout_method: {
        method,
        account,
        holder_name: holderName || "",
        updated_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { merge: true });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("partners/payout-method update error", error);
    return res.status(500).json({ error: "Failed to save payout method" });
  }
});

app.get("/api/partners/commissions", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });
  const period = String(req.query?.period || "").trim();

  try {
    await ensureManualPlusCommissionRowsForPartner(partnerId, period || toPeriodKey(new Date()));
    const snap = await firestore.collection("commission_ledger").where("partner_id", "==", partnerId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    if (period) rows = rows.filter((r) => String(r.period || "") === period);

    const normalized = rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const summary = {
      pending: roundCurrency(normalized
        .filter((r) => String(r.status || "").toLowerCase() === "pending")
        .reduce((sum, r) => sum + safeNumber(r.commission_amount, 0), 0)),
      approved: roundCurrency(normalized
        .filter((r) => String(r.status || "").toLowerCase() === "approved")
        .reduce((sum, r) => sum + safeNumber(r.commission_amount, 0), 0)),
      paid: roundCurrency(normalized
        .filter((r) => String(r.status || "").toLowerCase() === "paid")
        .reduce((sum, r) => sum + safeNumber(r.commission_amount, 0), 0)),
    };

    if (String(req.query?.format || "").toLowerCase() === "csv") {
      const header = [
        "period",
        "client_user_id",
        "plan_type",
        "base_amount",
        "rate_applied",
        "commission_amount",
        "status",
        "is_first_payment",
      ].join(",");
      const rowsCsv = normalized.map((r) => [
        csvClean(r.period),
        csvClean(r.client_user_id),
        csvClean(r.plan_type),
        csvClean(r.base_amount),
        csvClean(r.rate_applied),
        csvClean(r.commission_amount),
        csvClean(r.status),
        csvClean(r.is_first_payment),
      ].join(","));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=\"partner-commissions-${partnerId}.csv\"`);
      return res.status(200).send([header, ...rowsCsv].join("\n"));
    }

    return res.status(200).json({ ledger: normalized, summary });
  } catch (error) {
    console.error("partners/commissions error", error);
    return res.status(500).json({ error: "Failed to load commissions" });
  }
});

app.get("/api/partners/payouts", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_payouts").where("partner_id", "==", partnerId).get();
    const payouts = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return res.status(200).json({ payouts });
  } catch (error) {
    console.error("partners/payouts list error", error);
    return res.status(500).json({ error: "Failed to load payouts" });
  }
});

app.get("/api/partners/users", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: false, allowSuperAdmin: true });
  if (!authCtx) return;
  const partnerId = authCtx.partnerId || String(req.query?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("partner_users").where("partner_id", "==", partnerId).get();
    const users = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    return res.status(200).json({ users });
  } catch (error) {
    console.error("partners/users list error", error);
    return res.status(500).json({ error: "Failed to load partner users" });
  }
});

app.post("/api/partners/users/invite", async (req, res) => {
  const authCtx = await requirePartnerContext(req, res, { requireAdmin: true, allowSuperAdmin: false });
  if (!authCtx) return;

  const email = cleanText(req.body?.email).toLowerCase();
  const role = normalizePartnerRole(req.body?.role);
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email is required" });

  try {
    const inviteId = makeId("pinv");
    const nowIso = new Date().toISOString();
    await firestore.collection("partner_invites").doc(inviteId).set({
      partner_id: authCtx.partnerId,
      email,
      role,
      status: "pending",
      invited_by: authCtx.uid,
      created_at: nowIso,
      updated_at: nowIso,
    });

    const signupUrl = buildPartnerCheckoutUrl(req, { invite: inviteId, account: "partner" });
    return res.status(200).json({ success: true, invite_id: inviteId, signup_url: signupUrl });
  } catch (error) {
    console.error("partners/users invite error", error);
    return res.status(500).json({ error: "Failed to create invite" });
  }
});

app.get("/api/admin/partners", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    const partnersSnap = await firestore.collection("partners").get();
    await Promise.all(partnersSnap.docs.map((docSnap) => ensureManualPlusCommissionRowsForPartner(docSnap.id)));
    const clientsSnap = await firestore.collection("profiles").get();
    const ledgerSnap = await firestore.collection("commission_ledger").get();
    const payoutsSnap = await firestore.collection("partner_payouts").get();
    const clients = clientsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const ledger = ledgerSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const payouts = payoutsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

    const partners = partnersSnap.docs.map((docSnap) => {
      const partner = docSnap.data() || {};
      const partnerClients = clients.filter((c) => c.partner_id === docSnap.id);
      const partnerLedger = ledger.filter((l) => l.partner_id === docSnap.id);
      const pending = roundCurrency(partnerLedger
        .filter((l) => String(l.status || "").toLowerCase() === "pending")
        .reduce((sum, l) => sum + safeNumber(l.commission_amount, 0), 0));
      const paid = roundCurrency(partnerLedger
        .filter((l) => String(l.status || "").toLowerCase() === "paid")
        .reduce((sum, l) => sum + safeNumber(l.commission_amount, 0), 0));
      const pendingPayouts = payouts.filter((p) => p.partner_id === docSnap.id && String(p.status || "").toLowerCase() !== "paid").length;

      return {
        id: docSnap.id,
        name: partner.name || "Partner",
        code: partner.code || "",
        status: partner.status || "active",
        commission_first_rate: safeNumber(partner.commission_first_rate, 0.5),
        commission_recurring_rate: safeNumber(partner.commission_recurring_rate, 0.3),
        kpis: {
          clients_total: partnerClients.length,
          clients_active: partnerClients.filter((c) => String(c.subscription_status || "").toLowerCase() === "active").length,
          commissions_pending: pending,
          commissions_paid: paid,
          pending_payouts: pendingPayouts,
        },
      };
    });

    return res.status(200).json({ partners });
  } catch (error) {
    console.error("admin partners list error", error);
    return res.status(500).json({ error: "Failed to load partners" });
  }
});

app.patch("/api/admin/partners/:partnerId", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const partnerId = String(req.params?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  const updates = { updated_at: new Date().toISOString() };
  if (typeof req.body?.name === "string") updates.name = cleanText(req.body.name).slice(0, 120);
  if (typeof req.body?.status === "string") {
    const status = cleanText(req.body.status).toLowerCase();
    if (PARTNER_STATUSES.has(status)) updates.status = status;
  }
  if (req.body?.commission_first_rate != null) {
    updates.commission_first_rate = safeNumber(req.body.commission_first_rate, 0.5);
  }
  if (req.body?.commission_recurring_rate != null) {
    updates.commission_recurring_rate = safeNumber(req.body.commission_recurring_rate, 0.3);
  }

  try {
    await firestore.collection("partners").doc(partnerId).set(updates, { merge: true });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("admin partners patch error", error);
    return res.status(500).json({ error: "Failed to update partner" });
  }
});

app.get("/api/admin/partners/:partnerId/clients", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const partnerId = String(req.params?.partnerId || "").trim();
  if (!partnerId) return res.status(400).json({ error: "Missing partnerId" });

  try {
    const snap = await firestore.collection("profiles").where("partner_id", "==", partnerId).get();
    const clients = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    return res.status(200).json({ clients });
  } catch (error) {
    console.error("admin partner clients error", error);
    return res.status(500).json({ error: "Failed to load partner clients" });
  }
});

app.post("/api/admin/partners/:partnerId/reassign-client", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const partnerId = String(req.params?.partnerId || "").trim();
  const clientUserId = String(req.body?.client_user_id || "").trim();
  if (!partnerId || !clientUserId) return res.status(400).json({ error: "Missing partnerId or client_user_id" });

  try {
    await firestore.collection("profiles").doc(clientUserId).set({
      partner_id: partnerId,
      attribution_source: "admin_reassign",
      attributed_partner_locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { merge: true });

    await firestore.collection("audit_events").add({
      actor_uid: decoded.uid,
      event_type: "partner_client_reassign",
      partner_id: partnerId,
      client_user_id: clientUserId,
      created_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("admin partner reassign error", error);
    return res.status(500).json({ error: "Failed to reassign client" });
  }
});

app.post("/api/admin/commissions/:ledgerId/approve", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const ledgerId = String(req.params?.ledgerId || "").trim();
  if (!ledgerId) return res.status(400).json({ error: "Missing ledgerId" });

  try {
    await firestore.collection("commission_ledger").doc(ledgerId).set({
      status: "approved",
      approved_by: decoded.uid,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { merge: true });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("admin commission approve error", error);
    return res.status(500).json({ error: "Failed to approve commission" });
  }
});

app.post("/api/admin/payouts/create", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const partnerId = String(req.body?.partner_id || "").trim();
  const period = String(req.body?.period || "").trim() || toPeriodKey(new Date());
  if (!partnerId) return res.status(400).json({ error: "Missing partner_id" });

  try {
    await ensureManualPlusCommissionRowsForPartner(partnerId, period);
    const ledgerSnap = await firestore.collection("commission_ledger").where("partner_id", "==", partnerId).get();
    const eligible = ledgerSnap.docs.filter((d) => {
      const data = d.data() || {};
      return String(data.period || "") === period && ["pending", "approved"].includes(String(data.status || "").toLowerCase());
    });
    if (!eligible.length) return res.status(400).json({ error: "No eligible ledger rows for payout" });

    const totalAmount = roundCurrency(eligible.reduce((sum, d) => sum + safeNumber(d.data()?.commission_amount, 0), 0));
    const nowIso = new Date().toISOString();
    const payoutRef = firestore.collection("partner_payouts").doc();
    await payoutRef.set({
      partner_id: partnerId,
      period,
      total_amount: totalAmount,
      status: "approved",
      created_by: decoded.uid,
      created_at: nowIso,
      updated_at: nowIso,
    });

    const batch = firestore.batch();
    eligible.forEach((docSnap) => {
      batch.set(docSnap.ref, {
        status: "approved",
        payout_id: payoutRef.id,
        updated_at: nowIso,
      }, { merge: true });
    });
    await batch.commit();

    return res.status(200).json({ success: true, payout_id: payoutRef.id });
  } catch (error) {
    console.error("admin payouts create error", error);
    return res.status(500).json({ error: "Failed to create payout" });
  }
});

app.post("/api/admin/payouts/:payoutId/mark-paid", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
  const callerIsSuperAdmin = await isSuperAdmin(decoded);
  if (!callerIsSuperAdmin) return res.status(403).json({ error: "Forbidden" });

  const payoutId = String(req.params?.payoutId || "").trim();
  if (!payoutId) return res.status(400).json({ error: "Missing payoutId" });

  try {
    const payoutRef = firestore.collection("partner_payouts").doc(payoutId);
    const payoutSnap = await payoutRef.get();
    if (!payoutSnap.exists) return res.status(404).json({ error: "Payout not found" });
    const payout = payoutSnap.data() || {};

    const nowIso = new Date().toISOString();
    await payoutRef.set({
      status: "paid",
      paid_at: nowIso,
      paid_by: decoded.uid,
      payment_reference: cleanText(req.body?.payment_reference || ""),
      updated_at: nowIso,
    }, { merge: true });

    const ledgerSnap = await firestore.collection("commission_ledger").where("payout_id", "==", payoutId).get();
    const batch = firestore.batch();
    ledgerSnap.docs.forEach((docSnap) => {
      batch.set(docSnap.ref, {
        status: "paid",
        paid_at: nowIso,
        updated_at: nowIso,
      }, { merge: true });
    });
    await batch.commit();

    await firestore.collection("audit_events").add({
      actor_uid: decoded.uid,
      event_type: "partner_payout_paid",
      payout_id: payoutId,
      partner_id: payout.partner_id || null,
      period: payout.period || null,
      amount: payout.total_amount || null,
      created_at: nowIso,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("admin payouts mark-paid error", error);
    return res.status(500).json({ error: "Failed to mark payout as paid" });
  }
});

app.get("/api/widget-config/:identity", async (req, res) => {
  const identity = (req.params.identity || "").trim();
  if (!identity) {
    return res.status(400).json({ error: "Missing widget identity" });
  }

  try {
    const widgetData = await getWidgetConfigByIdentity(identity);
    if (!widgetData) {
      return res.status(404).json({ error: "Widget config not found" });
    }

    const profileDoc = await firestore.collection("profiles").doc(widgetData.user_id).get();
    const profileData = profileDoc.exists ? profileDoc.data() : {};
    let partnerData = {};
    if (profileData?.partner_id) {
      const partnerSnap = await firestore.collection("partners").doc(profileData.partner_id).get();
      partnerData = partnerSnap.exists ? partnerSnap.data() || {} : {};
    }
    const publicConfig = mapWidgetToPublicConfig(widgetData, profileData, identity, partnerData);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ config: publicConfig });
  } catch (error) {
    console.error("widget-config error", error);
    return res.status(500).json({ error: "Failed to load widget config" });
  }
});

app.get("/api/w/:widgetId.js", async (req, res) => {
  const { widgetId } = req.params;
  if (!widgetId) return res.status(400).send("// widgetId is required");

  try {
    let widgetDoc = await firestore.collection("widget_configs").doc(widgetId).get();
    let widgetData = widgetDoc.exists ? { id: widgetDoc.id, ...widgetDoc.data() } : null;

    if (!widgetData) {
      const q = await firestore.collection("widget_configs").where("widget_id", "==", widgetId).limit(1).get();
      if (!q.empty) {
        widgetData = { id: q.docs[0].id, ...q.docs[0].data() };
      }
    }

    if (!widgetData) {
      res.setHeader("Content-Type", "application/javascript");
      return res.status(404).send("// Widget not found");
    }

    const profileDoc = await firestore.collection("profiles").doc(widgetData.user_id).get();
    const profileData = profileDoc.exists ? profileDoc.data() : {};
    let partnerData = {};
    if (profileData?.partner_id) {
      const partnerSnap = await firestore.collection("partners").doc(profileData.partner_id).get();
      partnerData = partnerSnap.exists ? partnerSnap.data() || {} : {};
    }
    const publicConfig = mapWidgetToPublicConfig(widgetData, profileData, widgetId, partnerData);

    if (publicConfig.experienceMode === "lead_chat") {
      const leadChatUrl = publicConfig.leadChatUrl || "";
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      return res.status(200).send(
        `console.warn("LeadWidget: This account uses Lead Chat page mode. Use ${leadChatUrl}");`,
      );
    }

    if (profileData?.subscription_status === "suspended") {
      res.setHeader("Content-Type", "application/javascript");
      return res.status(200).send('console.warn("LeadWidget: Service suspended for this account.");');
    }

    const embedUrl = getWidgetEmbedUrl(req);
    const cacheTag = encodeURIComponent(String(publicConfig.updatedAt || Date.now()));
    const embedUrlWithCache = `${embedUrl}${embedUrl.includes("?") ? "&" : "?"}cfg=${cacheTag}`;

    const firebasePublic = getPublicFirebaseConfig();
    const script = `
(function () {
  window.LEADWIDGET_CLIENT_ID = ${JSON.stringify(publicConfig.clientId)};
  window.LEADWIDGET_WIDGET_ID = ${JSON.stringify(publicConfig.widgetId)};
  window.LEADWIDGET_CONFIG = Object.assign({}, window.LEADWIDGET_CONFIG || {}, {
    clientId: ${JSON.stringify(publicConfig.clientId)},
    widgetId: ${JSON.stringify(publicConfig.widgetId)},
    businessName: ${JSON.stringify(publicConfig.businessName)},
    primaryColor: ${JSON.stringify(publicConfig.primaryColor)},
    whatsappDestination: ${JSON.stringify(publicConfig.whatsappDestination)},
    language: ${JSON.stringify(publicConfig.language)},
    facebookPixelId: ${JSON.stringify(publicConfig.facebookPixelId)},
    tiktokPixelId: ${JSON.stringify(publicConfig.tiktokPixelId)},
    googleTagId: ${JSON.stringify(publicConfig.googleTagId)},
    experienceMode: ${JSON.stringify(publicConfig.experienceMode || "widget")},
    leadChatSlug: ${JSON.stringify(publicConfig.leadChatSlug || "")},
    leadChatUrl: ${JSON.stringify(publicConfig.leadChatUrl || "")},
    consentText: ${JSON.stringify(publicConfig.consentText || "")},
    consentTextVersion: ${JSON.stringify(publicConfig.consentTextVersion || "v1")},
    iacloserRedirectUrl: ${JSON.stringify(publicConfig.iacloserRedirectUrl || "")},
    iacloserEnabled: ${JSON.stringify(publicConfig.iacloserEnabled === true)},
    leadChatHeadline: ${JSON.stringify(publicConfig.leadChatHeadline || "")},
    leadChatSubheadline: ${JSON.stringify(publicConfig.leadChatSubheadline || "")},
    leadChatOfferTitle: ${JSON.stringify(publicConfig.leadChatOfferTitle || "")},
    leadChatOfferDescription: ${JSON.stringify(publicConfig.leadChatOfferDescription || "")},
    leadChatCtaLabel: ${JSON.stringify(publicConfig.leadChatCtaLabel || "")},
    leadChatLiveToasts: ${JSON.stringify(publicConfig.leadChatLiveToasts || [])},
    customTrackingCode: "",
    hideBranding: ${JSON.stringify(publicConfig.hideBranding)},
    brandingText: ${JSON.stringify(publicConfig.brandingText || "")},
    brandingLink: ${JSON.stringify(publicConfig.brandingLink || "")},
    projectId: ${JSON.stringify(firebasePublic.projectId)},
    apiKey: ${JSON.stringify(firebasePublic.apiKey)}
  });

  (function initializeTracking(cfg) {
    try {
      var w = window;
      var d = document;
      if (!cfg || !cfg.widgetId) return;

      var initialized = (w.__LEADWIDGET_TRACKING_INIT__ = w.__LEADWIDGET_TRACKING_INIT__ || {});
      if (initialized[cfg.widgetId]) return;
      initialized[cfg.widgetId] = true;

      var safeDomId = function (value) {
        return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
      };

      var loadOnce = function (id, src) {
        if (!id || d.getElementById(id)) return;
        var script = d.createElement("script");
        script.id = id;
        script.async = true;
        script.src = src;
        (d.head || d.body || d.documentElement).appendChild(script);
      };

      if (cfg.facebookPixelId) {
        w.__LEADWIDGET_FB_PIXELS__ = w.__LEADWIDGET_FB_PIXELS__ || {};
        if (!w.__LEADWIDGET_FB_PIXELS__[cfg.facebookPixelId]) {
          !(function (f, b, e, v, n, t, s) {
            if (f.fbq) return;
            n = f.fbq = function () {
              n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
            };
            if (!f._fbq) f._fbq = n;
            n.push = n;
            n.loaded = true;
            n.version = "2.0";
            n.queue = [];
            t = b.createElement(e);
            t.async = true;
            t.src = v;
            s = b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t, s);
          })(w, d, "script", "https://connect.facebook.net/en_US/fbevents.js");
          w.fbq("init", cfg.facebookPixelId);
          w.__LEADWIDGET_FB_PIXELS__[cfg.facebookPixelId] = true;
        }
        if (typeof w.fbq === "function") {
          w.fbq("track", "PageView");
        }
      }

      if (cfg.tiktokPixelId) {
        w.__LEADWIDGET_TT_PIXELS__ = w.__LEADWIDGET_TT_PIXELS__ || {};
        if (!w.__LEADWIDGET_TT_PIXELS__[cfg.tiktokPixelId]) {
          !(function (wRef, dRef, tRef) {
            wRef.TiktokAnalyticsObject = tRef;
            var ttq = (wRef[tRef] = wRef[tRef] || []);
            ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
            ttq.setAndDefer = function (obj, method) {
              obj[method] = function () {
                obj.push([method].concat(Array.prototype.slice.call(arguments, 0)));
              };
            };
            for (var i = 0; i < ttq.methods.length; i++) {
              ttq.setAndDefer(ttq, ttq.methods[i]);
            }
            ttq.load = function (id) {
              var scriptId = "leadwidget-tiktok-" + safeDomId(id);
              loadOnce(scriptId, "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=" + encodeURIComponent(id) + "&lib=ttq");
            };
            ttq.loaded = true;
          })(w, d, "ttq");
          w.ttq.load(cfg.tiktokPixelId);
          w.__LEADWIDGET_TT_PIXELS__[cfg.tiktokPixelId] = true;
        }
        if (w.ttq && typeof w.ttq.page === "function") {
          w.ttq.page();
        }
      }

      if (cfg.googleTagId) {
        w.__LEADWIDGET_GTAG_IDS__ = w.__LEADWIDGET_GTAG_IDS__ || {};
        if (!w.__LEADWIDGET_GTAG_IDS__[cfg.googleTagId]) {
          var gtagScriptId = "leadwidget-gtag-" + safeDomId(cfg.googleTagId);
          loadOnce(gtagScriptId, "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.googleTagId));
          w.dataLayer = w.dataLayer || [];
          w.gtag =
            w.gtag ||
            function () {
              w.dataLayer.push(arguments);
            };
          w.gtag("js", new Date());
          w.gtag("config", cfg.googleTagId);
          w.__LEADWIDGET_GTAG_IDS__[cfg.googleTagId] = true;
        } else if (typeof w.gtag === "function") {
          w.gtag("config", cfg.googleTagId);
        }
      }

    } catch (trackingError) {
      console.warn("LeadWidget: tracking initialization failed", trackingError);
    }
  })(window.LEADWIDGET_CONFIG || {});

  var id = "leadwidget-embed-script";
  if (document.getElementById(id)) return;

  var s = document.createElement("script");
  s.id = id;
  s.async = true;
  s.src = ${JSON.stringify(embedUrlWithCache)};
  (document.head || document.body || document.documentElement).appendChild(s);
})();
`;

    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.status(200).send(script);
  } catch (error) {
    console.error("widget script error", error);
    res.setHeader("Content-Type", "application/javascript");
    return res.status(500).send("// Error generating widget script");
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`leads-widget-backend listening on :${port}`);
});
