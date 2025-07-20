// planner-prompts.js

export function buildWeeklyPlannerPrompt(profile, payload) {
  const {
    intentNotes,
    meals,
    cravings,
    tags,
    specialPlans,
    useFavorites
  } = payload;

  let prompt = `You're acting as a private chef and fitness-minded culinary coach for a client following a full-flavor approach to fitness.

This user is pursuing sustainable fitness without restriction. They want tasty, craveable meals. Every dish should deliciously align with their goals and gravitate toward the Protein and Plants Framework: which prioritizes lean protein (~25–33% of the plate) and plants (~50% of the plate) with chef-level flavor built from thoughtful techniques, concepts, and ingredients.

Use their Flavor Profile as a base layer for personalization—but this is a special 7-day planning request, and your job is to help them plan meals that meet their cravings, mood, and short-term context while staying aligned with their goals.

⚠️ Do NOT include low-protein meals, random snacks, or flavorless fitness foods. Every dish should support their goals while making them excited to eat.`;

  prompt += `

Client's focus for the week:
${intentNotes || "(No specific direction — use flavor profile and inputs below)"}

Inputs to reflect in this week's plan:`;

  if (Array.isArray(meals) && meals.length > 0) {
    prompt += `\n- Meals to include: ${meals.join(", ")}`;
  }

  if (cravings) {
    prompt += `\n- Cravings or ingredient focus: ${cravings}`;
  }

  if (tags?.length) {
    prompt += `\n- Desired vibe or tone: ${tags.join(", ")}`;
  }

  if (specialPlans) {
    prompt += `\n- Context or constraints: ${specialPlans}`;
  }

  if (useFavorites) {
    prompt += `\n- Optionally remix 1–2 of their saved favorite meals`;
  }

  prompt += `

Respond with ONLY valid JSON like:
{
  "Mon": [{ "mealType": "Breakfast", "title": "..." }, ...],
  ...
  "Sun": [...]
}`;

  return prompt;
}

export function buildDayPlannerPrompt(profile, payload) {
  const {
    intentNotes,
    meals,
    cravings,
    tags,
    specialPlans,
    useFavorites
  } = payload;

  let prompt = `You're acting as a private chef and fitness-minded culinary coach for a client following a full-flavor approach to fitness.

This user is pursuing sustainable fitness without restriction. They want tasty, craveable meals. Every dish should deliciously align with their goals and gravitate toward the Protein and Plants Framework: which prioritizes lean protein (~25–33% of the plate) and plants (~50% of the plate). This framework includes wiggle room for fun ways to fill up and round out meals, but chef-level flavor is primarily built from thoughtful techniques, concepts, and ingredients.

Use their Flavor Profile as a base layer for personalization—but this is a special planning request: you're planning a 1-day custom meal experience for a client and your job is to help them plan meals that reflect what they're in the mood for *today* (meet their cravings, mood, and short-term context) while staying aligned with their goals.

⚠️ Do NOT include low-protein meals, random snacks, or flavorless fitness foods. Every dish should support their goals while making them excited to eat. You're designing a short-term game plan with long-term intent for food lovers that want to be fit`;

  prompt += `

Client's goal for today:
${intentNotes || "(No specific direction — use flavor profile and inputs below)"}

Inputs to reflect in today's plan:`;

  if (Array.isArray(meals) && meals.length > 0) {
    prompt += `\n- Meals to include: ${meals.join(", ")}`;
  }

  if (cravings) {
    prompt += `\n- Cravings or ingredient focus: ${cravings}`;
  }

  if (tags?.length) {
    prompt += `\n- Mood or vibe: ${tags.join(", ")}`;
  }

  if (specialPlans) {
    prompt += `\n- Day context or events: ${specialPlans}`;
  }

  if (useFavorites) {
    prompt += `\n- Optionally remix a favorite meal if it fits`;
  }

  prompt += `

Respond with ONLY valid JSON like:
[
  { "mealType": "Lunch", "title": "..." },
  { "mealType": "Dinner", "title": "..." }
]`;

  return prompt;
}