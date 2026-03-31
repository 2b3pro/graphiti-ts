/**
 * Extraction language instruction — port of Python's get_extraction_language_instruction().
 */

/**
 * Returns instruction for multilingual extraction behavior.
 * Override this function to customize language extraction per group.
 *
 * @param groupId - Optional partition identifier for the graph
 * @returns Language instruction string to append to system messages
 */
export function getExtractionLanguageInstruction(_groupId?: string | null): string {
  return (
    '\n\nAny extracted information should be returned in the same language as it was written in. ' +
    'Only output non-English text when the user has written full sentences or phrases in that non-English language. ' +
    'Otherwise, output English.'
  );
}
