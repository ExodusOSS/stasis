export enum Color {
  Red = 1,
  Green = 2,
}

export const greet = (c: Color): string => `color:${c}`
