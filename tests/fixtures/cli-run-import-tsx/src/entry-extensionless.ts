// The extensionless specifier only resolves through tsx's resolver (Node requires the extension);
// tsx rewrites it to './hello.ts' before stasis's inner hook records the edge.
import { Color, greet } from './hello'

console.log(greet(Color.Green))
