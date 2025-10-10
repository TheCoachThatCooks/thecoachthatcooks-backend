// webhooks.js (ESM)
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import admin from "firebase-admin";

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
  const token = process.env.GHL_ACCESS_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return;

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    LocationId: locationId, // v1 requires this header
  };

  // 1) Upsert contact (v1)
  let contactId;
  try {
    const res = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        firstName: (name || "").split(/\s+/)[0] || "",
        phone: phone || undefined,
        tags: ["FlavorCoach", "Checkout Completed", "Free until Jan 1"],
        customField: {
          // v1 supports custom fields by name if you mapped them; or skip if not needed yet
        },
      }),
    });
    const text = await res.text();
    console.log("GHL v1 upsert contact:", res.status, text.slice(0, 400));
    const json = safeJson(text);
    contactId = json?.contact?.id || json?.id || json?.data?.id;
  } catch (e) {
    console.warn("GHL v1 upsert failed:", e.message);
    return;
  }

  // 2) Create opportunity in Trial stage (v1)
  const pipelineId = process.env.GHL_PIPELINE_ID;
  const stageId = process.env.GHL_TRIAL_STAGE_ID;
  if (contactId && pipelineId && stageId) {
    try {
      const res = await fetch("https://rest.gohighlevel.com/v1/opportunities/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "FlavorCoach – $10/mo",
          monetaryValue: 10,
          status: "open",
          pipelineId,
          stageId,
          contactId,
          // location is implied by LocationId header
        }),
      });
      const text = await res.text();
      console.log("GHL v1 create opportunity:", res.status, text.slice(0, 400));
    } catch (e) {
      console.warn("GHL v1 opportunity failed:", e.message);
    }
  }

  function safeJson(t) { try { return JSON.parse(t); } catch { return {}; } }
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
