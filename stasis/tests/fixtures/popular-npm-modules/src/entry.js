import express from 'express'
import lodash from 'lodash'
import chalk from 'chalk'
import debug from 'debug'
import semver from 'semver'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import dotenv from 'dotenv'
import pc from 'picocolors'
import { nanoid } from 'nanoid'

const out = []
out.push(['express.app', typeof express() === 'function'])
out.push(['lodash.chunk', JSON.stringify(lodash.chunk([1, 2, 3, 4, 5], 2))])
out.push(['chalk.red', chalk.red('x').includes('x')])
out.push(['debug.fn', typeof debug('test') === 'function'])
out.push(['semver.gt', semver.gt('2.0.0', '1.2.3')])
out.push(['uuid.len', uuidv4().length])
out.push(['axios.create', typeof axios.create === 'function'])
out.push(['dotenv.parse', JSON.stringify(dotenv.parse('A=1\nB=2'))])
out.push(['picocolors.green', pc.green('ok').includes('ok')])
out.push(['nanoid.length', nanoid().length])
console.log(JSON.stringify(out))
