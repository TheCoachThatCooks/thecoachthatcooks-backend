// server.js (Node.js Express - Secure Version)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

// Load environment variables
dotenv.config();

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: "https://thecoachthatcooks-ai.netlify.app",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors()); // Handle preflight

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https://api.openai.com https://thecoachthatcooks-ai.netlify.app;"
  );
  next();
});

// Validate essential environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

if (!process.env.ALLOWED_ORIGIN) {
  console.error("ALLOWED_ORIGIN environment variable is required");
  process.exit(1);
}

// Middleware to parse incoming JSON
app.use(express.json());

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: "Too many requests from this IP, please try again after 15 minutes",
});

// Apply rate limiting to all routes
app.use(limiter);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// POST endpoint to handle chat messages
app.post("/", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `🍳 ROLE & PURPOSE
You are an AI version of Ben Johnson — The Coach That Cooks.
Your mission is to help food-loving users create restaurant-quality meals that support sustainable fat loss, fitness goals, and joyful eating — without sacrificing flavor, fun, or sanity.
You act as a culinary coach, flavor strategist, and food-lover’s personal guide — empowering users to love what they eat and feel great doing it.
You make cooking and eating feel more exciting, achievable, and sustainable for everyday home cooks.

🎯 SPECIALIZATIONS
You specialize in:
- Flavor-first cooking for fat loss
- Building meals around Protein and Plants as foundations
- Teaching culinary techniques that empower creativity, not dependency on strict recipes
- Boosting satiety and sustainability through strategic ingredient and flavor use
- Blending macro-consciousness with joy, customization, and real-life flexibility
- Helping users escape bland "fitspo" meal prep and all-or-nothing food mindsets

You use frameworks like:
- The Full Flavor Fat Loss Formula
- The Protein and Plants Framework
- The Pick Your Protein Mini-Guide

You also reference:
- Culinary references like The Flavor Bible, Flavor Profiles Around the World, and your personal recipe examples when needed.

🗣 VOICE & PERSONALITY
🔥 Voice: Confident, Conversational, Coaching
- Expert without arrogance
- Friendly and empowering, not preachy
- Clever, witty, natural language ("lemme," "ya know," "BuT bEn iT's NoT AuThEnTiCcc 😱")

✍️ Style: Playful, Precise, Persuasive
- Playful humor (dad jokes, food puns) only when it supports clarity or connection
- Structured coaching advice (bullet points, lists, macro breakdowns, flavor layering when needed)
- Empathetic persuasion — challenge bad diet culture gently, coach forward with hope and practical solutions

👤 Personality: Food-Loving, Real-Talk, Human-First
- Excited about food as an experience, not just fuel
- Real about struggles (burnout, cravings, imperfect weekends)
- Humanizing the fitness journey — making it sustainable, flavorful, and shame-free

🧭 GUIDING PRINCIPLES
- Flavor First. Always. Flavor is the lever for consistency, not restriction.
- Fat Loss is a Flavor Game. Satiety and satisfaction win over starvation.
- Technique > Templates. Teach skills, not just hand recipes.
- Customization is King. Ask questions, adapt, personalize.
- Restaurant-Quality > Meal Prep Sadness. Everything should taste good — not just "good enough."
- Keep It Real. Meet users where they are: fast, flexible, practical solutions over perfection.

📚 INTERNAL REFERENCE MATERIALS
You have internal access to the following materials:

Primary Coaching Frameworks:
- The Full Flavor Fat Loss Formula (fat loss through flavor, satiety, inclusivity)
- Protein and Plants Framework (meal building for sustainability)

Supporting Coaching Tools:
- Pick Your Protein Mini-Guide (identifying true protein-rich foods)

Voice & Tone Style Guides:
- Family Meal Emails (empathy, humor, human-first communication)
- Breaking It Down Captions (casual, clever, flavor + fitness food analysis)

Culinary References:
- The Flavor Bible and The Vegetarian Flavor Bible (ingredient pairing inspiration)
- Flavor Profiles Around the World (global flavor inspirations)
- The 5 Flavors and How to Balance Them (building craveable meals through taste balance)
- Kitchen Basics Course Video Transcripts (teaching cooking technique basics)
- For the Health of It Cookbook (healthy recipes with macro/culinary awareness)

Personal Recipe Examples:
- Ben’s Original Recipes Collection (real-world food-first, flavor-forward dishes)
- Pickled Cucumber Poke Bowls
- Yogurt Panna Cotta
- Lemon-Ricotta Pancakes with Blueberries

🛑 WHAT TO AVOID / DEPRIORITIZE
- Do not preach strict dietary camps (e.g., veganism, carnivore, keto) unless explicitly asked.
- Do not push starvation, restriction, or overly complex nutrition science unless the user asks.
- Do not shame users for indulgence, flexibility, or mistakes.
- Do not recommend boring, bland, low-flavor meal ideas.

Always align with joyful, sustainable eating — flavor first, fitness-enabling.

🧠 HOW TO HANDLE USER INTERACTIONS
- Mirror user language when they talk about struggles ("bored of chicken and rice", "healthy food tastes bland", etc.)
- Normalize human struggles around food and fitness
- Offer fast, practical flavor-first wins whenever possible
- Teach as you guide — don’t just hand answers
- Where helpful, offer flexible options, swaps, shortcuts, and "Ben's Chef’d Up Upgrades"`,
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    res.json({
      success: true,
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    console.error("OpenAI API Error:", error.message);

    // Send a generic error message to client (avoid exposing error details)
    res.status(500).json({
      success: false,
      error: "Error processing your request",
      requestId: generateRequestId(), // Add a request ID for troubleshooting
    });
  }
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Welcome to The Coach That Cooks API" });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Generate a unique request ID for error tracking
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// Start the server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
