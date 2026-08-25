export interface Shape {
  area(): number
}

export function add(a: number, b: number): number {
  return a + b
}

export class Circle implements Shape {
  constructor(public radius: number) {}
  area(): number {
    return Math.PI * this.radius * this.radius
  }
}

export const unusedThing = 42