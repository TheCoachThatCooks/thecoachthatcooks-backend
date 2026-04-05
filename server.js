import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { buildSystemPrompt } from "./prompt.js"; // <-- ✅ Modular brain
import {
  buildWeeklyPlannerPrompt,
  buildDayPlannerPrompt,
  buildInstructionsPrompt
} from "./planner-prompts.js";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
import { registerStripeWebhooks } from "./webhooks.js";
import multer from "multer";

dotenv.config();

console.log("🧪 Using Firebase cert path:", "/etc/secrets/firebase-service-account.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert("/etc/secrets/firebase-service-account.json")
  });
}

const db = getFirestore();
console.log("✅ Firestore DB initialized");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024 // 8MB
  }
});

app.use(
  cors({
    origin: [
      "https://flavorcoach.ai",
      "https://www.flavorcoach.ai",
      "https://thecoachthatcooks-ai.netlify.app",
      "https://staging--thecoachthatcooks-ai.netlify.app",
      "https://fitfoodlovers.com",
      "https://www.fitfoodlovers.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https://api.openai.com https://thecoachthatcooks-ai.netlify.app https://flavorcoach.ai https://www.flavorcoach.ai;"
  );
  next();
});

if (!process.env.OPENAI_API_KEY || !process.env.ALLOWED_ORIGIN) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

registerStripeWebhooks(app);

app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use(limiter);

// Legacy checkout routes from old "Free until Jan 1" promo.
// Current production signup uses Stripe Payment Links instead.

// POST /api/checkout/session
// Creates a Stripe Checkout Session for your $10/mo plan.
// - Collects a card now
// - Sets trial_end to Jan 1 (9:00am Eastern) if that’s in the future
app.post("/api/checkout/session", async (req, res) => {
  try {
    const PRICE_ID = process.env.PRICE_ID; // your $10/mo Price ID from Stripe
    if (!PRICE_ID) {
      return res.status(500).json({ error: "Missing PRICE_ID env var on the server" });
    }

    const now = Math.floor(Date.now() / 1000);
    const trialEnd = nextJan1UnixEastern();
    const subscription_data = {};
    if (trialEnd > now) {
      subscription_data.trial_end = trialEnd; // absolute calendar date
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],

      // collect a card now so Stripe can charge on Jan 1
      payment_method_collection: "always",

      // collect phone number inside Checkout
      phone_number_collection: { enabled: true },

      // reassuring text right in the Checkout button area
      custom_text: {
        submit: {
          message: subscription_data.trial_end
            ? "Free until Jan 1. You won’t be charged today."
            : "Billing starts immediately."
        }
      },

      subscription_data,

      // TODO: set these to your real routes/pages
      success_url:
        "https://thecoachthatcooks-ai.netlify.app/create-account.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://thecoachthatcooks-ai.netlify.app/cancel"
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// GET /checkout/start  → creates a session and redirects to Stripe Checkout
app.get("/checkout/start", async (req, res) => {
  try {
    const PRICE_ID = process.env.PRICE_ID;
    if (!PRICE_ID) return res.status(500).send("Missing PRICE_ID");

    const now = Math.floor(Date.now() / 1000);
    const trialEnd = nextJan1UnixEastern();
    const subscription_data = {};
    if (trialEnd > now) subscription_data.trial_end = trialEnd;

    // Optional: capture simple attribution from query string
    const { utm_source = "", utm_medium = "", utm_campaign = "", source = "ghl" } = req.query;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      payment_method_collection: "always",
      phone_number_collection: { enabled: true },
      custom_text: {
        submit: {
          message: subscription_data.trial_end
            ? "Free until Jan 1. You won’t be charged today."
            : "Billing starts immediately."
        }
      },
      subscription_data,
      metadata: { source, utm_source, utm_medium, utm_campaign },
      success_url: "https://thecoachthatcooks-ai.netlify.app/create-account.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://thecoachthatcooks-ai.netlify.app/cancel"
    });

    res.redirect(303, session.url); // redirect straight to Stripe
  } catch (e) {
    console.error(e);
    res.status(400).send(e.message);
  }
});

// 9:00am Jan 1 in New York = 14:00:00 UTC
function nextJan1UnixEastern() {
  const now = new Date();
  const useNextYear =
    now.getUTCMonth() > 0 || (now.getUTCMonth() === 0 && now.getUTCDate() > 1);
  const year = useNextYear ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return Math.floor(Date.UTC(year, 0, 1, 14, 0, 0) / 1000); // 14:00Z = 9:00am ET
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function stripCodeFences(text = "") {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * 📸 Breakdown Route (image upload + AI analysis)
 */
app.post("/api/breakdown", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file received." });
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Unsupported image type." });
    }

    const allowedGoals = ["higher_protein", "lighter", "balanced", "keep_the_vibe"];
    const goalMode = allowedGoals.includes(req.body.goalMode)
      ? req.body.goalMode
      : "higher_protein";

    const base64Image = req.file.buffer.toString("base64");
    const imageDataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

    const goalLabelMap = {
      higher_protein: "Higher Protein",
      lighter: "Lighter",
      balanced: "Better Balanced",
      keep_the_vibe: "Keep the Vibe"
    };

    const prompt = `
You are FlavorCoach Breakdown, a chef-driven healthy eating assistant.

Your job:
Analyze the food image and give a useful, concise, highly readable “chef’s breakdown.”
Do NOT be preachy. Do NOT sound like a calorie tracker. Do NOT shame the food.
Be practical, vivid, and realistic.

The selected goal is: ${goalLabelMap[goalMode]}.

Important rules:
- Work from what is visible in the image.
- If uncertain, speak in likely terms, not false certainty.
- Preserve the spirit/vibe of the dish when suggesting upgrades.
- Focus on high-impact moves, not nitpicky advice.
- Keep output punchy and camera-friendly.
- Return ONLY valid JSON. No markdown. No code fences.

Return this exact JSON shape:
{
  "dishName": "short name for the dish or meal situation",
  "quickRead": "1-2 sentence read on what this appears to be",
  "mainIssue": "biggest improvement opportunity in one sentence",
  "upgradeHeadline": "one punchy sentence describing the better version",
  "chefMoves": [
    "short practical move 1",
    "short practical move 2",
    "short practical move 3"
  ],
  "resultSummary": "short payoff line that feels compelling",
  "confidenceNote": "brief note that this is a visual estimate"
}
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: imageDataUrl,
              detail: "high"
            }
          ]
        }
      ]
    });

    const rawText = response.output_text || "";
    const cleanedText = stripCodeFences(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("Breakdown JSON parse failed:", cleanedText);
      return res.status(500).json({
        error: "AI returned an invalid breakdown format."
      });
    }

    if (
      !parsed.dishName ||
      !parsed.quickRead ||
      !parsed.upgradeHeadline ||
      !Array.isArray(parsed.chefMoves) ||
      !parsed.resultSummary
    ) {
      return res.status(500).json({
        error: "AI returned an incomplete breakdown."
      });
    }

    return res.json({
      success: true,
      breakdown: {
        dishName: parsed.dishName,
        quickRead: parsed.quickRead,
        mainIssue: parsed.mainIssue || "",
        upgradeHeadline: parsed.upgradeHeadline,
        chefMoves: parsed.chefMoves.slice(0, 5),
        resultSummary: parsed.resultSummary,
        confidenceNote:
          parsed.confidenceNote || "Visual estimate only — exact ingredients and portions may vary."
      }
    });

  } catch (error) {
    console.error("Breakdown route error:", error);
    return res.status(500).json({ error: "Server error handling breakdown request." });
  }
});

/**
 * 🔁 Chat Route (memory enabled)
 */
app.post("/", async (req, res) => {
  const { messages, uid } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages array is required" });
  }

  let flavorProfile = null;
  
  if (uid && typeof uid === "string" && uid.trim() !== "") {
    try {
      const userDoc = await db.collection("users").doc(uid).get();
      if (userDoc.exists) {
        flavorProfile = userDoc.data()?.flavorProfile || null;
      }
    } catch (err) {
      console.warn("⚠️ Failed to load flavor profile for UID:", uid, err.message);
    }
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(flavorProfile)
        },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    res.json({
      success: true,
      reply: completion.choices[0].message.content,
    });

  } catch (error) {
    console.error("OpenAI API Error:", error.message || error);
    res.status(500).json({ success: false, error: "Error processing your request." });
  }
});

/**
 * 📅 New /generate-week-plan route
 */
app.post("/generate-week-plan", async (req, res) => {
  try {
    const { profile, payload } = req.body;

    if (!profile || !payload) {
      return res.status(400).json({ success: false, error: "Missing data." });
    }

    const { mode, meals, cravings, tags, specialPlans, useFavorites } = payload;

    const userMessage = buildWeeklyPlannerPrompt(profile, payload);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildSystemPrompt(profile) },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    let result = completion.choices[0].message.content.trim();
    if (result.startsWith("```")) {
      result = result.replace(/```(?:json)?/i, "").replace(/```$/, "").trim();
    }
    
    const plan = JSON.parse(result);
    const isoPlan = plan; // GPT now returns ISO-keyed plan already
    
    // ✅ Send the ISO-keyed plan to the frontend
    res.json(isoPlan);

  } catch (error) {
    console.error("❌ Failed to generate weekly plan:", error.message || error);
    res.status(500).json({ success: false, error: "Failed to generate meal plan." });
  }
});

/**
 * 📅 New /generate-day-plan route
 */
app.post("/generate-day-plan", async (req, res) => {
  try {
    const { profile, payload } = req.body;

    if (!profile || !payload) {
      return res.status(400).json({ success: false, error: "Missing data." });
    }

    const { meals, cravings, tags, specialPlans, useFavorites } = payload;

    const userMessage = buildDayPlannerPrompt(profile, payload);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildSystemPrompt(profile) },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    let result = completion.choices[0].message.content.trim();
    if (result.startsWith("```")) {
      result = result.replace(/```(?:json)?/i, "").replace(/```$/, "").trim();
    }

    const plan = JSON.parse(result);

    // Wrap in today's ISO key so frontend expects same structure
    const iso = payload.targetDate || new Date().toISOString().split("T")[0];
    const isoPlan = { [iso]: plan };

    res.json(isoPlan);

  } catch (error) {
    console.error("❌ Failed to generate day plan:", error.message || error);
    res.status(500).json({ success: false, error: "Failed to generate day plan." });
  }
});

/**
 * 👨🏻‍🍳 New /generate-instructions route
 */
app.post("/generate-instructions", async (req, res) => {
  const { title, tags = [], flavorProfile = {}, plannerInput = {} } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: "Missing meal title" });
  }

  console.log("📥 /generate-instructions payload:", { title, tags, plannerInput });

  try {
    const userMessage = buildInstructionsPrompt(title, flavorProfile, tags, plannerInput);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildSystemPrompt(flavorProfile) },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    let output = completion.choices[0].message.content.trim();

    if (output.startsWith("```")) {
      output = output.replace(/```(?:markdown)?/i, "").replace(/```$/, "").trim();
    }

    res.json({ instructions: output });
  } catch (error) {
    console.error("❌ Error generating instructions:", error.message);
    res.status(500).json({ error: "Failed to generate meal instructions." });
  }
});

/**
 * ✍️ Metadata Summarizer
 */
app.post("/generate-metadata", async (req, res) => {
  const { content } = req.body;

  if (!content || typeof content !== "string") {
    return res.status(400).json({ success: false, error: "Missing or invalid content." });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an assistant that summarizes user-generated text and suggests metadata for saving. 

Return only valid JSON:
{
  "title": "...",
  "summary": "...",
  "tags": ["...", "..."]
}`
        },
        {
          role: "user",
          content: content
        }
      ],
      temperature: 0.5,
      max_tokens: 200
    });

    let responseText = completion.choices[0].message.content.trim();
    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    }

    let metadata;
    try {
      metadata = JSON.parse(responseText);
    } catch (err) {
      console.error("❌ Failed to parse metadata:", responseText);
      return res.status(500).json({ success: false, error: "Failed to parse AI metadata." });
    }

    if (!metadata.title || !metadata.summary || !Array.isArray(metadata.tags)) {
      return res.status(500).json({ success: false, error: "Incomplete metadata returned." });
    }

    res.json({ success: true, ...metadata });

  } catch (error) {
    console.error("OpenAI Metadata Error:", error);
    res.status(500).json({ success: false, error: "Failed to generate metadata." });
  }
});

/**
 * 🔐 reCAPTCHA Verification
 */
app.post("/verify-recaptcha", async (req, res) => {
  const { token } = req.body;

  if (!token) return res.status(400).json({ success: false, message: "Missing reCAPTCHA token" });

  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${token}`
    });

    const data = await response.json();

    if (!data.success || (data.score !== undefined && data.score < 0.5)) {
      return res.status(403).json({ success: false, message: "reCAPTCHA verification failed" });
    }

    res.json({ success: true, score: data.score });

  } catch (error) {
    console.error("💥 reCAPTCHA error:", error);
    res.status(500).json({ success: false, message: "Verification error" });
  }
});

/**
 * 🔍 Health Check
 */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
