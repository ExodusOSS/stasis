export interface Greeting {
  text: string
}

export const greet = (name: string): string => {
  const g: Greeting = { text: `hello, ${name}` }
  return g.text
}
