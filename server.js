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

app.use(
  cors({
    origin: [
      "https://thecoachthatcooks-ai.netlify.app",
      "https://staging--thecoachthatcooks-ai.netlify.app"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https://api.openai.com https://thecoachthatcooks-ai.netlify.app;"
  );
  next();
});

if (!process.env.OPENAI_API_KEY || !process.env.ALLOWED_ORIGIN) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use(limiter);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
