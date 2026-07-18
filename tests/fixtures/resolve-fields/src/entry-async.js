import lazydep from 'lazydep'

export async function load() {
  return import('./lazy.js')
}

export { lazydep }
