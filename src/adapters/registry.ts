import type { ProviderAdapter } from '../core/types'
import { brave } from './brave'
import { desearch } from './desearch'
import { exa } from './exa'
import { jina } from './jina'
import { linkup } from './linkup'
import { nimble } from './nimble'
import { parallel } from './parallel'
import { perplexity } from './perplexity'
import { sailor } from './sailor'
import { searchx } from './searchx'
import { tavily } from './tavily'

export const ADAPTERS: ProviderAdapter[] = [brave, exa, parallel, perplexity, tavily, jina, linkup, nimble, desearch, sailor, searchx]

export function getAdapter(name: string): ProviderAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name.toLowerCase())
}
