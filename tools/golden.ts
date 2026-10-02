/** Prints the generator golden hashes (paste into src/core/gen/golden.ts after an intentional change). */
import { generationHash } from '../src/core/gen/golden.ts';

console.log(JSON.stringify({ 1: generationHash(1, 200), 2024: generationHash(2024, 200) }));
