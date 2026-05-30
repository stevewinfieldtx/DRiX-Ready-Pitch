// prompts/pitch.js — Loads both Pitch system prompts.
//
// Pitch is split into TWO parallel LLM calls to avoid token-budget pressure
// that was causing the LLM to drop pivot text in nested response arrays.
//
//   PITCH_KIT_PROMPT    → the meeting kit (pain, lead, talking, discovery,
//                          objection, competitive, script, next_move).
//   PITCH_EMAILS_PROMPT → the 5-email pre-meeting outreach drip.
//
// Both prompts receive the SAME input payload. They run via Promise.all in
// server.js. The results are merged into a single response.
//
// PITCH_SYSTEM_PROMPT is kept as a back-compat re-export = PITCH_KIT_PROMPT.

const fs = require('fs');
const path = require('path');

const PITCH_KIT_PROMPT = fs.readFileSync(
  path.join(__dirname, 'pitch-kit.txt'),
  'utf8'
);

const PITCH_EMAILS_PROMPT = fs.readFileSync(
  path.join(__dirname, 'pitch-emails.txt'),
  'utf8'
);

// Back-compat — anything still importing the old single prompt gets the kit.
const PITCH_SYSTEM_PROMPT = PITCH_KIT_PROMPT;

module.exports = { PITCH_KIT_PROMPT, PITCH_EMAILS_PROMPT, PITCH_SYSTEM_PROMPT };
