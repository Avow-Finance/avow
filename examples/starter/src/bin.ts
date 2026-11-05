#!/usr/bin/env node
import { main } from './create.js'

process.exitCode = await main(process.argv.slice(2))
