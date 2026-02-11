import express from "express";
import OpenAI from "openai";
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

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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

function toDateKey(date) {
  return date.toISOString().split("T")[0];
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

  return "https://whatsapp-leads-peru.vercel.app/widget-embed.js";
}

function getPublicFirebaseConfig() {
  return {
    projectId: (process.env.FIREBASE_PUBLIC_PROJECT_ID || "leads-widget").trim(),
    apiKey: (process.env.FIREBASE_PUBLIC_API_KEY || "AIzaSyCXNFoeg1nrYcFHzU9TEKNnDPg1mHU3_tA").trim(),
  };
}

async function getWidgetConfigByIdentity(widgetId) {
  let q = await firestore.collection("widget_configs").where("widget_id", "==", widgetId).limit(1).get();
  if (q.empty) {
    q = await firestore.collection("widget_configs").where("user_id", "==", widgetId).limit(1).get();
  }
  if (q.empty) return null;

  const doc = q.docs[0];
  return { id: doc.id, ...doc.data() };
}

function mapWidgetToPublicConfig(widgetData, profileData = {}, identity) {
  const fallbackWidgetId = widgetData?.widget_id || widgetData?.id || identity;
  return {
    clientId: widgetData?.user_id || identity,
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
    teaserMessages: Array.isArray(widgetData?.teaser_messages) ? widgetData.teaser_messages : [],
    quickReplies: Array.isArray(widgetData?.quick_replies) ? widgetData.quick_replies : [],
    launcherIcon: widgetData?.launcher_icon || "",
    hideBranding: widgetData?.hide_branding === true,
    ai_enabled: widgetData?.ai_enabled === true,
    ai_provider: widgetData?.ai_provider || "openai",
    ai_api_key: widgetData?.ai_api_key || "",
    ai_model: widgetData?.ai_model || "gpt-4o-mini",
    ai_system_prompt: widgetData?.ai_system_prompt || "",
    business_description: widgetData?.business_description || "",
    ai_temperature: Number(widgetData?.ai_temperature || 0.7),
    ai_max_tokens: Number(widgetData?.ai_max_tokens || 500),
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
    try {
      const blocked = await firestore
        .collection("blocked_ips")
        .where("ip_address", "==", clientIp)
        .where("widget_id", "==", widgetId)
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

  if (forbiddenPatterns.some((pattern) => pattern.test(message))) {
    try {
      await firestore.collection("blocked_ips").add({
        widget_id: widgetId,
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
    try {
      const blockedQuery = await firestore
        .collection("blocked_ips")
        .where("ip_address", "==", clientIp)
        .limit(1)
        .get();
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

    let widgetData = null;
    let profileData = {};

    if (widgetId !== "demo-landing") {
      widgetData = await getWidgetConfigByIdentity(widgetId);
      if (!widgetData) {
        return res.status(404).json({ error: "Widget not found" });
      }

      const profileDoc = await firestore.collection("profiles").doc(widgetData.user_id).get();
      profileData = profileDoc.exists ? profileDoc.data() : {};

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
    } else {
      profileData = {
        ai_enabled: true,
        ai_model: "gpt-4o-mini",
      };
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

    const defaultPrompt = widgetId === "demo-landing"
      ? "You are LeadWidget commercial assistant. Qualify the lead and when user confirms send [WHATSAPP_REDIRECT: ...]. Keep replies short."
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

    const shouldBlock =
      aiResponse.includes("block_user") ||
      aiResponse.includes("Security Violation Detected") ||
      aiResponse.includes("I cannot help with that") ||
      aiResponse.includes("no puedo ayudar con eso");

    if (shouldBlock) {
      try {
        await firestore.collection("blocked_ips").add({
          widget_id: widgetData?.id || widgetId,
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

app.post("/api/users/bootstrap", async (req, res) => {
  const decoded = await decodeTokenIfPresent(req);
  if (!decoded?.uid) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const uid = decoded.uid;
  const email = (decoded.email || "").toLowerCase();
  const businessName = (req.body?.businessName || "").toString().trim();
  const referredBy = req.body?.referredBy || null;
  const now = new Date().toISOString();

  try {
    const profileRef = firestore.collection("profiles").doc(uid);
    const profileSnap = await profileRef.get();
    let created = false;

    if (!profileSnap.exists) {
      created = true;
      await profileRef.set({
        email: decoded.email || null,
        business_name: businessName,
        created_at: now,
        updated_at: now,
        subscription_status: "trial",
        ai_enabled: false,
        ai_model: "gpt-4o-mini",
        referred_by: referredBy,
      });
    } else {
      const updates = { updated_at: now };
      if (businessName) updates.business_name = businessName;
      await profileRef.set(updates, { merge: true });
    }

    if (SUPERADMIN_EMAILS.has(email)) {
      await firestore.collection("user_roles").doc(uid).set(
        { role: "superadmin", updated_at: now },
        { merge: true }
      );
      return res.status(200).json({ success: true, role: "superadmin", created });
    }

    return res.status(200).json({ success: true, role: "client", created });
  } catch (error) {
    console.error("bootstrap user error", error);
    return res.status(500).json({ error: "Failed to bootstrap user profile" });
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
    const targetEmail = (profileSnap.data()?.email || "").toLowerCase();
    const targetRoleSnap = await firestore.collection("user_roles").doc(targetUserId).get();
    const targetRole = (targetRoleSnap.data()?.role || "").toLowerCase();

    if (targetUserId === decoded.uid || SUPERADMIN_EMAILS.has(targetEmail) || targetRole === "superadmin") {
      return res.status(403).json({ error: "Protected superadmin account cannot be deleted" });
    }

    const configSnap = await firestore
      .collection("widget_configs")
      .where("user_id", "==", targetUserId)
      .get();

    const batch = firestore.batch();
    batch.delete(profileRef);
    batch.delete(firestore.collection("user_roles").doc(targetUserId));

    configSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    return res.status(200).json({ success: true });
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
  const insecureAllowed = String(process.env.ALLOW_INSECURE_VERIFY_PAYMENT || "true").toLowerCase() === "true";

  let targetUserId = decoded?.uid || null;
  if (!targetUserId && insecureAllowed) {
    targetUserId = user_id || null;
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

    await firestore.collection("payments").add({
      user_id: targetUserId,
      amount,
      currency,
      payment_method: "PayPal",
      description: "Lead Widget Subscription",
      status: "completed",
      paypal_order_id: orderID,
      payer_email: orderData?.payer?.email_address || "unknown",
      created_at: new Date().toISOString(),
      verified_by_server: true,
    });

    await firestore.collection("profiles").doc(targetUserId).set({
      subscription_status: "active",
      plan_type: plan_type || "pro",
      trial_ends_at: null,
      updated_at: new Date().toISOString(),
    }, { merge: true });

    return res.status(200).json({ success: true, message: "Payment verified and subscription activated" });
  } catch (error) {
    console.error("verify-payment error", error);
    return res.status(500).json({ error: error?.message || "Internal server error" });
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
    const publicConfig = mapWidgetToPublicConfig(widgetData, profileData, identity);

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
    const publicConfig = mapWidgetToPublicConfig(widgetData, profileData, widgetId);

    if (profileData?.subscription_status === "suspended") {
      res.setHeader("Content-Type", "application/javascript");
      return res.status(200).send('console.warn("LeadWidget: Service suspended for this account.");');
    }

    const embedUrl = getWidgetEmbedUrl(req);

    const firebasePublic = getPublicFirebaseConfig();
    const script = `
(function () {
  window.LEADWIDGET_CLIENT_ID = ${JSON.stringify(publicConfig.clientId)};
  window.LEADWIDGET_CONFIG = Object.assign({}, window.LEADWIDGET_CONFIG || {}, {
    clientId: ${JSON.stringify(publicConfig.clientId)},
    widgetId: ${JSON.stringify(publicConfig.widgetId)},
    businessName: ${JSON.stringify(publicConfig.businessName)},
    primaryColor: ${JSON.stringify(publicConfig.primaryColor)},
    whatsappDestination: ${JSON.stringify(publicConfig.whatsappDestination)},
    language: ${JSON.stringify(publicConfig.language)},
    projectId: ${JSON.stringify(firebasePublic.projectId)},
    apiKey: ${JSON.stringify(firebasePublic.apiKey)}
  });

  var id = "leadwidget-embed-script";
  if (document.getElementById(id)) return;

  var s = document.createElement("script");
  s.id = id;
  s.async = true;
  s.src = ${JSON.stringify(embedUrl)};
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
