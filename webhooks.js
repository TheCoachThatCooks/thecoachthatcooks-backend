// webhooks.js (ESM)
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import admin from "firebase-admin";

// ---- Resolve a v1 stageId by stage NAME (robust, with fallbacks) ----
const _stageIdCache = new Map();

async function resolveV1StageIdByName({ pipelineId, stageName }) {
  const key = `${pipelineId}::${stageName}`;
  if (_stageIdCache.has(key)) return _stageIdCache.get(key);

  const v1Key = (process.env.GHL_V1_API_KEY || "").trim();
  const loc   = (process.env.GHL_LOCATION_ID || "").trim();
  if (!v1Key || !loc) throw new Error("Missing GHL_V1_API_KEY or GHL_LOCATION_ID");

  const headers = {
    Authorization: `Bearer ${v1Key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    LocationId: loc,
  };

  const matchName = s => (s || "").toLowerCase() === (stageName || "").toLowerCase();

  // Try 1: filtered opps (some tenants 404 here)
  try {
    const r = await fetch(`https://rest.gohighlevel.com/v1/opportunities/?pipelineId=${encodeURIComponent(pipelineId)}&limit=100`, { headers });
    const t = await r.text();
    if (r.ok) {
      let j; try { j = JSON.parse(t); } catch { j = []; }
      const opps = Array.isArray(j) ? j : (j?.opportunities || j?.data || []);
      const hit  = opps.find(o => matchName(o.stageName));
      if (hit?.stageId) {
        _stageIdCache.set(key, hit.stageId);
        console.log("[GHL V1] resolved stageId from opps (filtered):", { stageName, stageId: hit.stageId });
        return hit.stageId;
      }
    } else {
      console.warn("[GHL V1] filtered opps 404/err:", r.status, t.slice(0,200));
    }
  } catch (e) {
    console.warn("[GHL V1] filtered opps error:", e.message);
  }

  // Try 2: unfiltered opps, then filter client-side
  try {
    const r2 = await fetch(`https://rest.gohighlevel.com/v1/opportunities/?limit=100`, { headers });
    const t2 = await r2.text();
    if (r2.ok) {
      let j2; try { j2 = JSON.parse(t2); } catch { j2 = []; }
      const opps2 = Array.isArray(j2) ? j2 : (j2?.opportunities || j2?.data || []);
      // prefer matching pipeline + stage name
      const hit2 = opps2.find(o => o.pipelineId === pipelineId && matchName(o.stageName))
              || opps2.find(o => matchName(o.stageName));
      if (hit2?.stageId) {
        _stageIdCache.set(key, hit2.stageId);
        console.log("[GHL V1] resolved stageId from opps (unfiltered):", { stageName, stageId: hit2.stageId });
        return hit2.stageId;
      }
    } else {
      console.warn("[GHL V1] unfiltered opps 404/err:", r2.status, t2.slice(0,200));
    }
  } catch (e) {
    console.warn("[GHL V1] unfiltered opps error:", e.message);
  }

  // Try 3: pipeline object may include stages
  try {
    const rp = await fetch(`https://rest.gohighlevel.com/v1/pipelines/${encodeURIComponent(pipelineId)}`, { headers });
    const tp = await rp.text();
    if (rp.ok) {
      let pj; try { pj = JSON.parse(tp); } catch { pj = {}; }
      const stages = pj?.stages || pj?.pipeline?.stages || pj?.data?.stages || [];
      const s = Array.isArray(stages) && stages.find(s => matchName(s.name));
      if (s?.id) {
        _stageIdCache.set(key, s.id);
        console.log("[GHL V1] resolved stageId from pipeline object:", { stageName, stageId: s.id });
        return s.id;
      }
      console.warn("[GHL V1] pipeline object had no matching stage name; keys:", Object.keys(pj||{}));
    } else {
      console.warn("[GHL V1] pipeline object err:", rp.status, tp.slice(0,200));
    }
  } catch (e) {
    console.warn("[GHL V1] pipeline object fetch error:", e.message);
  }

  throw new Error(`Could not resolve v1 stageId for "${stageName}"`);
}

async function logGhlV1PipelinesAndStagesOnce() {
  try {
    const key = (process.env.GHL_V1_API_KEY || "").trim();
    const loc = (process.env.GHL_LOCATION_ID || "").trim();
    if (!key || !loc) { console.warn("[GHL V1 DEBUG] missing key/location"); return; }

    const h = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      LocationId: loc,
    };

    // Pipelines (v1)
    const pRes = await fetch("https://rest.gohighlevel.com/v1/pipelines/", { headers: h });
    const pTxt = await pRes.text();
    if (!pRes.ok) { console.warn("[GHL V1 DEBUG] pipelines failed:", pRes.status, pTxt.slice(0,300)); return; }

    let pJson;
    try { pJson = JSON.parse(pTxt); } catch { pJson = pTxt; }
    const pipelines = Array.isArray(pJson) ? pJson : (pJson?.pipelines || pJson?.data || []);
    console.log("[GHL V1 DEBUG] Pipelines:", pipelines.map(p => ({ id: p.id, name: p.name })));

    // Stages per pipeline (v1)
    for (const p of pipelines) {
      const pid = p.id;
      const sRes = await fetch(`https://rest.gohighlevel.com/v1/pipelines/${encodeURIComponent(pid)}/stages`, { headers: h });
      const sTxt = await sRes.text();
      if (!sRes.ok) { console.warn(`[GHL V1 DEBUG] stages failed for ${pid}:`, sRes.status, sTxt.slice(0,300)); continue; }

      let sJson;
      try { sJson = JSON.parse(sTxt); } catch { sJson = sTxt; }
      const stages = Array.isArray(sJson) ? sJson : (sJson?.stages || sJson?.data || []);
      console.log(`[GHL V1 DEBUG] Stages for ${pid} (${p.name}):`, stages.map(s => ({ id: s.id, name: s.name })));
    }
  } catch (e) {
    console.warn("[GHL V1 DEBUG] error:", e.message);
  }
}
// call once on boot:
logGhlV1PipelinesAndStagesOnce();

async function logGhlPipelinesAndStagesOnce() {
  try {
    const v2 = process.env.GHL_V2_ACCESS_TOKEN;
    const loc = process.env.GHL_LOCATION_ID;
    const wantPipeline = process.env.GHL_PIPELINE_ID;

    if (!v2 || !loc) {
      console.warn("[GHL DEBUG] Missing GHL_V2_ACCESS_TOKEN or GHL_LOCATION_ID");
      return;
    }

    const baseHeaders = {
      Authorization: `Bearer ${v2}`,
      Version: "2021-07-28",
      Accept: "application/json",
      LocationId: loc,
    };

    // 1) List pipelines this token can see for this Location
    const pRes = await fetch("https://services.leadconnectorhq.com/v2/pipelines/", { headers: baseHeaders });
    const pTxt = await pRes.text();
    if (!pRes.ok) {
      console.warn("[GHL DEBUG] Pipelines list failed:", pRes.status, pTxt.slice(0, 400));
      return;
    }
    const pipelines = JSON.parse(pTxt)?.pipelines || JSON.parse(pTxt)?.data || JSON.parse(pTxt);
    console.log("[GHL DEBUG] Pipelines for Location", loc, pipelines);

    // 2) For each pipeline, list stages
    for (const p of pipelines || []) {
      const pid = p.id || p.pipelineId;
      const name = p.name || p.title;
      const sRes = await fetch(`https://services.leadconnectorhq.com/v2/pipelines/${encodeURIComponent(pid)}/stages`, {
        headers: baseHeaders,
      });
      const sTxt = await sRes.text();
      if (!sRes.ok) {
        console.warn(`[GHL DEBUG] Stages list failed for pipeline ${pid} (${name}):`, sRes.status, sTxt.slice(0, 400));
        continue;
      }
      const stages = JSON.parse(sTxt)?.stages || JSON.parse(sTxt)?.data || JSON.parse(sTxt);
      console.log(`[GHL DEBUG] Stages for pipeline ${pid} (${name}):`);
      for (const st of stages || []) {
        console.log("  -", st.id, "→", st.name || st.title);
      }
    }

    // 3) Quick summary of what you *configured*
    console.log("[GHL DEBUG] Your envs:", {
      GHL_LOCATION_ID: loc,
      GHL_PIPELINE_ID: wantPipeline,
      GHL_TRIAL_STAGE_ID: process.env.GHL_TRIAL_STAGE_ID,
    });
  } catch (e) {
    console.warn("[GHL DEBUG] error:", e.message);
  }
}

// call once at startup:
logGhlPipelinesAndStagesOnce();

// --- GHL config (v1 = contacts, v2 = opportunities) ---
const GHL_LOCATION_ID     = process.env.GHL_LOCATION_ID;
const GHL_V1_API_KEY      = process.env.GHL_V1_API_KEY;        // Business Profile API key (v1)
const GHL_V2_ACCESS_TOKEN = process.env.GHL_V2_ACCESS_TOKEN;   // Private Integration token (v2)

// Optional safety logs (won't crash)
if (!GHL_LOCATION_ID)     console.warn("Missing GHL_LOCATION_ID");
if (!GHL_V1_API_KEY)      console.warn("Missing GHL_V1_API_KEY (v1 contacts)");
if (!GHL_V2_ACCESS_TOKEN) console.warn("Missing GHL_V2_ACCESS_TOKEN (v2 opportunities)");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

/* ---------- Firestore (optional but recommended) ---------- */
let db = null;
try {
  if (!admin.apps.length) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
        ),
      });
    } else {
      admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS path if set
    }
  }
  db = admin.firestore();
} catch (e) {
  console.warn("Firestore init skipped:", e.message);
}

/* ---------- Single route: Stripe Webhook (raw body!) ---------- */
function registerStripeWebhooks(app) {
  app.post(
    "/api/stripe/webhook",
    bodyParser.raw({ type: "application/json" }), // must be raw for signature
    async (req, res) => {
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("Webhook signature failed:", err.message);
        return res.sendStatus(400);
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const s = event.data.object;
            const email = s.customer_details?.email || "";
            const name = s.customer_details?.name || "";
            const phone = s.customer_details?.phone || "";
            const customerId = s.customer;         // "cus_..."
            const subscriptionId = s.subscription; // "sub_..."

            await upsertGhlContactAndTrialOpp({
              name, email, phone, customerId, subscriptionId,
            });
            await convertKitSubscribe({ email, firstName: name });

            // Mirror basic subscription state into Firestore
            let fields = { status: "trialing" };
            if (subscriptionId) {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              fields = {
                status: sub.status,
                trial_end: sub.trial_end || null,
                current_period_end: sub.current_period_end || null,
                priceId: sub.items?.data?.[0]?.price?.id || null,
              };
            }
            await setStripeStatus(customerId, {
              email, sessionId: s.id, ...fields,
            });
            await attachToUserIfExists(customerId, fields);
            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const sub = event.data.object;
            const customerId = sub.customer;
            const fields = {
              status: sub.status,
              trial_end: sub.trial_end || null,
              current_period_end: sub.current_period_end || null,
              priceId: sub.items?.data?.[0]?.price?.id || null,
            };
            await setStripeStatus(customerId, fields);
            await attachToUserIfExists(customerId, fields);
            await moveGhlStageForStatus(customerId, fields.status);
            break;
          }

          case "invoice.payment_succeeded": {
            const customerId = event.data.object.customer;
            await moveGhlStageForStatus(customerId, "active");
            break;
          }

          case "invoice.payment_failed": {
            const customerId = event.data.object.customer;
            await moveGhlStageForStatus(customerId, "dunning");
            break;
          }
        }
        res.json({ received: true });
      } catch (err) {
        console.error("Webhook handler error:", err);
        res.sendStatus(500);
      }
    }
  );
}

/* ---------- GHL helpers (minimal) ---------- */
async function upsertGhlContactAndTrialOpp({ name, email, phone, customerId, subscriptionId }) {
  // ----- v1: upsert contact -----
  if (!GHL_V1_API_KEY || !GHL_LOCATION_ID) {
    console.warn("Skip GHL v1 upsert: missing GHL_V1_API_KEY or GHL_LOCATION_ID");
    return;
  }

  const v1Headers = {
    Authorization: `Bearer ${GHL_V1_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    LocationId: GHL_LOCATION_ID, // v1 accepts/uses this header
  };

  let contactId;
  try {
    const res = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers: v1Headers,
      body: JSON.stringify({
        email,
        firstName: (name || "").split(/\s+/)[0] || "",
        phone: phone || undefined,
        tags: ["FlavorCoach", "Checkout Completed", "Free until Jan 1"],
        // customField: {} // keep commented until you map fields
      }),
    });
    const text = await res.text();
    console.log("GHL v1 upsert contact:", res.status, text.slice(0, 400));
    const json = safeJson(text);
    contactId = json?.contact?.id || json?.id || json?.data?.id;
  } catch (e) {
    console.warn("GHL v1 upsert failed:", e.message);
    return; // don’t try to create an opp without a contact
  }

// ----- v1: create opportunity in Trial stage (using resolver) -----
const pipelineId = process.env.GHL_PIPELINE_ID;
const desiredStageName = (process.env.GHL_TRIAL_STAGE_NAME || "Trial").trim();
// Optional: if you’ve *already* discovered & want to hardcode the v1 id, set GHL_TRIAL_STAGE_ID_V1
let v1StageId = (process.env.GHL_TRIAL_STAGE_ID_V1 || "").trim();

if (!v1StageId) {
  try {
    v1StageId = await resolveV1StageIdByName({ pipelineId, stageName: desiredStageName });
  } catch (e) {
    console.warn("Stage resolve failed:", e.message);
  }
}

if (contactId && pipelineId && v1StageId) {
  try {
    const v1Headers = {
      Authorization: `Bearer ${GHL_V1_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      LocationId: GHL_LOCATION_ID,
    };

    console.log("GHL v1 create payload", { pipelineId, stageId: v1StageId, contactId });

    const res = await fetch("https://rest.gohighlevel.com/v1/opportunities/", {
      method: "POST",
      headers: v1Headers,
      body: JSON.stringify({
        name: "FlavorCoach – $10/mo",
        monetaryValue: 10,
        status: "open",
        pipelineId,
        stageId: v1StageId,       // v1 needs a v1 stageId (not the UUID)
        contactId,
        locationId: GHL_LOCATION_ID,
      }),
    });

    const text = await res.text();
    console.log("GHL v1 create opportunity:", res.status, text.slice(0, 400));
    if (!res.ok) throw new Error(`GHL v1 opportunity failed ${res.status} ${text}`);
  } catch (e) {
    console.warn("GHL v1 opportunity error:", e.message);
  }
} else {
  console.warn("GHL v1 create skipped: missing value(s)", { contactId, pipelineId, v1StageId });
}

  function safeJson(t) {
    try { return JSON.parse(t); } catch { return {}; }
  }
}

// simple stage mapper; expand later to “find & move existing opportunity”
async function moveGhlStageForStatus(_customerId, _status) {
  return; // no-op for now; safe to add later
}

/* ---------- ConvertKit helper ---------- */
async function convertKitSubscribe({ email, firstName }) {
  const key = process.env.CONVERTKIT_API_KEY;
  if (!key) return;
  if (process.env.CONVERTKIT_FORM_ID) {
    try {
      await fetch(`https://api.convertkit.com/v3/forms/${process.env.CONVERTKIT_FORM_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, email, first_name: firstName || "" }),
      });
    } catch (e) {
      console.warn("ConvertKit subscribe skipped:", e.message);
    }
  }
  const tagIds = (process.env.CONVERTKIT_TAG_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  for (const tagId of tagIds) {
    try {
      await fetch(`https://api.convertkit.com/v3/tags/${tagId}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, email }),
      });
    } catch (e) {
      console.warn("ConvertKit tag skipped:", e.message);
    }
  }
}

/* ---------- Firestore helpers ---------- */
async function setStripeStatus(customerId, fields) {
  if (!db || !customerId) return;
  await db.collection("stripe_customers").doc(String(customerId)).set(
    { ...fields, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function attachToUserIfExists(customerId, subscriptionFields) {
  if (!db || !customerId) return;
  const snap = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
  if (!snap.empty) {
    await snap.docs[0].ref.set({ subscription: subscriptionFields }, { merge: true });
  }
}

export { registerStripeWebhooks };
