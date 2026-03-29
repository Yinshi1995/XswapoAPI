const vowels = "aeiou"
const consonants = "bcdfghjklmnprstvz"

function randomInt(max: number): number {
  return Math.floor(Math.random() * max)
}

function generateWord(minLen: number, maxLen: number): string {
  const len = minLen + randomInt(maxLen - minLen + 1)
  let word = ""
  // Start with consonant or vowel randomly
  let useConsonant = randomInt(2) === 0
  while (word.length < len) {
    const pool = useConsonant ? consonants : vowels
    word += pool[randomInt(pool.length)]
    useConsonant = !useConsonant
  }
  return word
}

/**
 * Generate a pronounceable human-readable order ID.
 * Format: word-word → e.g. `bravel-somikt`
 * First word: 4–6 chars, second word: 5–7 chars.
 */
export function generateOrderId(): string {
  return `${generateWord(4, 6)}-${generateWord(5, 7)}`
}
