#!/usr/bin/env node
import { main } from './create.js'

process.exitCode = main(process.argv.slice(2))
