// prompts/pitch.js — Loads both Pitch system prompts AND defines the JSON
// schemas used in tool_use mode to FORCE the model to fill every field.
//
// Why schemas: prompt rules alone aren't enough — Sonnet sometimes drops
// nested pivot/next_step fields. With tool_use + required fields, the model
// is enforced by the API to produce complete output. No more retry whack-a-mole.

const fs = require('fs');
const path = require('path');

const PITCH_KIT_PROMPT = fs.readFileSync(path.join(__dirname, 'pitch-kit.txt'), 'utf8');
const PITCH_EMAILS_PROMPT = fs.readFileSync(path.join(__dirname, 'pitch-emails.txt'), 'utf8');
const PITCH_SYSTEM_PROMPT = PITCH_KIT_PROMPT; // back-compat

// ─── Schemas ──────────────────────────────────────────────────────────────
// JSON Schema (OpenAI tool-call style). Every "required" field MUST be present.
// minLength on string fields blocks the LLM from passing empty strings.

const responseObjSchema = {
  type: 'object',
  required: ['response', 'next_step'],
  properties: {
    response:  { type: 'string', minLength: 8 },
    next_step: { type: 'string', minLength: 8 }
  }
};
const negativeRespSchema = {
  type: 'object',
  required: ['response', 'pivot'],
  properties: {
    response: { type: 'string', minLength: 8 },
    pivot:    { type: 'string', minLength: 8 }
  }
};

const discoveryQuestionSchema = {
  type: 'object',
  required: ['stage', 'question', 'purpose', 'pain_it_targets', 'tone_guidance', 'positive_responses', 'neutral_negative_responses'],
  properties: {
    stage:                       { type: 'string', minLength: 3 },
    question:                    { type: 'string', minLength: 10 },
    purpose:                     { type: 'string', minLength: 5 },
    pain_it_targets:             { type: 'string', minLength: 1 },
    tone_guidance:               { type: 'string', minLength: 3 },
    positive_responses:          { type: 'array', minItems: 2, maxItems: 4, items: responseObjSchema },
    neutral_negative_responses:  { type: 'array', minItems: 2, maxItems: 4, items: negativeRespSchema }
  }
};

const PITCH_KIT_SCHEMA = {
  type: 'object',
  required: [
    'customer_summary', 'industry_inferred', 'pain_points', 'lead_with',
    'talking_points', 'discovery_questions', 'top_objection',
    'script_30s', 'next_move', 'confidence'
  ],
  properties: {
    customer_summary:  { type: 'string', minLength: 20 },
    industry_inferred: { type: 'string', minLength: 3 },
    pain_points: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object',
        required: ['id', 'headline', 'evidence', 'severity'],
        properties: {
          id:       { type: 'string', minLength: 1 },
          headline: { type: 'string', minLength: 10 },
          evidence: { type: 'string', minLength: 10 },
          severity: { type: 'integer', minimum: 0, maximum: 100 }
        }
      }
    },
    lead_with:      { type: 'string', minLength: 20 },
    talking_points: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string', minLength: 15 } },
    discovery_questions: { type: 'array', minItems: 3, maxItems: 3, items: discoveryQuestionSchema },
    top_objection: {
      type: 'object',
      required: ['objection', 'response'],
      properties: {
        objection: { type: 'string', minLength: 10 },
        response:  { type: 'string', minLength: 20 }
      }
    },
    competitive: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['competitor_name', 'their_strength', 'your_edge', 'landmine_question', 'if_they_say'],
          properties: {
            competitor_name:   { type: 'string', minLength: 2 },
            their_strength:    { type: 'string', minLength: 15 },
            your_edge:         { type: 'string', minLength: 15 },
            landmine_question: { type: 'string', minLength: 10 },
            if_they_say: {
              type: 'object',
              required: ['response', 'rep_says'],
              properties: {
                response: { type: 'string', minLength: 5 },
                rep_says: { type: 'string', minLength: 15 }
              }
            }
          }
        }
      ]
    },
    script_30s: { type: 'string', minLength: 40 },
    next_move:  { type: 'string', minLength: 15 },
    confidence: {
      type: 'object',
      required: ['score', 'notes'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        notes: { type: 'string', minLength: 5 }
      }
    }
  }
};

const PITCH_EMAILS_SCHEMA = {
  type: 'object',
  required: ['email_drip'],
  properties: {
    email_drip: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object',
        required: ['step', 'label', 'send_day', 'purpose', 'subject', 'body', 'if_no_response'],
        properties: {
          step:           { type: 'integer', minimum: 1, maximum: 5 },
          label:          { type: 'string', minLength: 3 },
          send_day:       { type: 'string', minLength: 3 },
          purpose:        { type: 'string', minLength: 5 },
          subject:        { type: 'string', minLength: 4 },
          body:           { type: 'string', minLength: 50 },
          if_no_response: { type: 'string', minLength: 5 }
        }
      }
    },
    confidence_note: { type: 'string' }
  }
};

module.exports = {
  PITCH_KIT_PROMPT,
  PITCH_EMAILS_PROMPT,
  PITCH_SYSTEM_PROMPT,
  PITCH_KIT_SCHEMA,
  PITCH_EMAILS_SCHEMA
};
