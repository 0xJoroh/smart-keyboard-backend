/**
 * ==============================================================================
 * 🧠 MASTER PROMPTS CONFIGURATION
 * ==============================================================================
 *
 * This file contains ALL the instructions (prompts) used by the AI backend.
 * Everything is organized here so it's easy to read and update.
 *
 * SECTIONS:
 * 1. GENERAL SYSTEM PROMPT (Used by all tools)
 * 2. TOOL-SPECIFIC INSTRUCTIONS (Unique to each button/tool)
 * 3. RESPONSE FORMAT (How the AI should format the answer)
 * 4. PROMPT BUILDER (The logic that combines everything - Developers only)
 */

// ==============================================================================
// 1. GENERAL SYSTEM PROMPT
// ==============================================================================
// This instruction is sent to the AI for EVERY request, regardless of the tool.
export const GENERAL_SYSTEM_PROMPT = `
You are a helpful, intelligent writing assistant embedded in a mobile IOS keyboard extension.
Your goal is to assist the user by transforming their text according to their specific intent.
Always ensure high quality, correctness, and maintaining the user's original meaning where appropriate.
`;

const LANGUAGE_INSTRUCTION = `ALWAYS RESPONDE WITH THE SAME LANGUAGE AS THE USER TEXT. the user might use multiple languages in the same text. so you will always need to maintain the original language of each sentence.`;

// ==============================================================================
// 2. TOOL-SPECIFIC INSTRUCTIONS
// ==============================================================================
// These instructions are defined by the tool ID.
// You can use {{option}} as a placeholder for dynamic values (like language or tone).
export const TOOL_INSTRUCTIONS: Record<string, string> = {
  rephrase: `${LANGUAGE_INSTRUCTION}. Rephrase the user's text while maintaining its exact meaning. Provide a single, high-quality rephrased version that flows better.`,

  "fix-mistakes": `
${LANGUAGE_INSTRUCTION}
You are a strict spelling and grammar checker.
Transform the user's text to correct all spelling, grammar, and punctuation mistakes.
IMPORTANT: 
- DO NOT rewrite the sentence or change its tone. 
- DO NOT be creative. Keep the original wording as much as possible.
- Output ONLY the corrected text directly.
- Ensure the output is a normal readable sentence without any special markup (#wrong#, [correct], etc.).
`,

  improve: `${LANGUAGE_INSTRUCTION}. Improve the user's text based on this style: {{option}}. Make it effective and professional.`,

  translate:
    "You are a professional translator. Translate the user's text to {{option}}. Provide only the translation.",

  "change-tone": `${LANGUAGE_INSTRUCTION}. Transform the user's text to match the {{option}} tone perfectly.`,
};

// ==============================================================================
// 3. TASK & RESPONSE FORMAT
// ==============================================================================
const RESPONSE_FORMAT_INSTRUCTIONS = `
TASK:
Improve or transform the 'USER TEXT' strictly following the INSTRUCTIONS.
- Provide the complete improved version of the text.
- Return ONLY the improved text directly.
- Do NOT use JSON wrapping.
- Do NOT use Markdown formatting.
- Do NOT add conversational fillers like "Here is your text:".
- Do NOT add any additional text or formatting.
- Do NOT add any additional quotation marks around your response.
`;

// ==============================================================================
// 4. PROMPT BUILDER (Developer Section)
// ==============================================================================

export interface PromptOptions {
  toolId: string;
  userInput: string;
  previousResults?: string[]; // To avoid repeating same suggestions
  metadata?: Record<string, string>; // Dynamic options (e.g. language, tone)
}

/**
 * Constructs the final prompt string sent to the AI model.
 */
export function buildFullPrompt(opts: PromptOptions): string {
  // 1. Determine the specific instruction
  let specificInstruction =
    TOOL_INSTRUCTIONS[opts.toolId] || "You are a helpful writing assistant.";

  // 2. Hydrate dynamic placeholders (e.g. {{option}})
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      specificInstruction = specificInstruction.replace(`{{${key}}}`, value);
    }
  }

  // Default fallback for translate/tone if option is missing
  specificInstruction = specificInstruction.replace(
    "{{option}}",
    "the requested style",
  );

  // 3. Handle previous results (History)
  let historyInstruction = "";
  if (opts.previousResults && opts.previousResults.length > 0) {
    const formattedHistory = opts.previousResults
      .map((r, i) => `${i + 1}. "${r}"`)
      .join("\n");
    historyInstruction = `
IMPORTANT: You have already generated the following results for this text. 
DO NOT repeat or closely rephrase any of them. Generate a meaningfully different version.
PREVIOUS RESULTS:
${formattedHistory}
`;
  }

  // 4. Combine everything
  return `
SYSTEM INSTRUCTION:
${GENERAL_SYSTEM_PROMPT}
=========
SPECIFIC INSTRUCTION:
${specificInstruction}
=========
USER TEXT:
${opts.userInput}
=========
${RESPONSE_FORMAT_INSTRUCTIONS}
=========
${historyInstruction}
`;
}
