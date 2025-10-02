/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2025-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import * as fs from 'node:fs/promises';
import * as readline from 'node:readline/promises';
import { execSync } from 'node:child_process';
import { default as jwtSimple } from 'jwt-simple';
import path from 'node:path';
import process from 'node:process';

/******************************************************************************/

export async function sleep(seconds) {
    return new Promise(resolve => {
        setTimeout(resolve, seconds * 1000);
    });
}

/******************************************************************************/

export async function prompt(message) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await rl.question(message);
    if ( answer !== 'yes' ) {
        console.log('Aborted');
        process.exit(1);
    }
    return true;
}

/******************************************************************************/

export async function fetchEx(...args) {
    const responseType = args.at(-1);
    let fetchArgs;
    switch ( responseType ) {
    case 'bytes':
    case 'json':
    case 'text':
        fetchArgs = args.slice(0, -1);
        break;
    default:
        fetchArgs = args.slice();
        break;
    }
    const response = await fetch(...fetchArgs).catch(reason => {
        console.log(`${reason}`);
    });
    if ( response === undefined ) { return { }; }
    if ( response.ok !== true ) {
        console.log(response.statusText);
        return { response };
    }
    let data;
    switch ( responseType ) {
    case 'bytes':
        data = await response.bytes();
        break;
    case 'json':
        data = await response.json();
        break;
    case 'text':
        data = await response.text();
        break;
    }
    return { response, data };
}

export function reportFetchError(response) {
    console.log(response.statusText);
}

/******************************************************************************/

export async function getManifest(path) {
    const text = await fs.readFile(path, { encoding: 'utf8' });
    return JSON.parse(text);
}

/******************************************************************************/

export async function getFileFromPackage(packagePath, needlePath) {
    const tempDir = await getTempDir();
    const filePath = await shellExec(`unzip -Z1 ${packagePath} | grep "${needlePath}"`);
    if ( Boolean(filePath) === false ) { return; }
    await shellExec(`unzip ${packagePath} ${filePath} -d ${tempDir}`);
    const text = await fs.readFile(`${tempDir}/${filePath}`, { encoding: 'utf8' });
    if ( text === undefined ) { return; }
    return text;
}

/******************************************************************************/

export async function getManifestFromPackage(packagePath) {
    const text = await getFileFromPackage(packagePath, 'manifest.json');
    if ( text === undefined ) { return; }
    return JSON.parse(text);
}

/******************************************************************************/

export async function updateManifestInPackage(packagePath, json) {
    const tempDir = await getTempDir('/tmp/github-deflated-asset-');
    const manifestPath = await shellExec(`unzip -Z1 ${packagePath} | grep manifest.json`);
    if ( Boolean(manifestPath) === false ) { return; }
    const manifestDir = path.dirname(manifestPath);
    if ( manifestDir !== '' && manifestDir !== '. ' ) {
        await shellExec(`mkdir -p ${tempDir}/${manifestDir}`);
    }
    await fs.writeFile(`${tempDir}/${manifestPath}`, JSON.stringify(json, null, 2));
    await shellExec(`cd ${tempDir} && zip -qr ${packagePath} ${manifestPath} && cd -`);
    return true;
}

/******************************************************************************/

export async function getExtensionNameFromPackage(packagePath) {
    const manifest = await getManifestFromPackage(packagePath);
    if ( manifest === undefined ) { return; }
    if ( manifest.name !== "__MSG_extName__" ) { return manifest.name; }
    const lang = manifest.default_locale;
    if ( lang === undefined ) { return; }
    const text = await getFileFromPackage(packagePath, `_locales/${lang}/messages.json`);
    if ( text === undefined ) { return; }
    const messages = JSON.parse(text);
    return messages.extName.message;
    
}

/******************************************************************************/

export class JWT {
    #issuer = '';
    #secret = '';
    #timeout = 60;

    constructor(issuer, secret, timeout = 60) {
        this.#issuer = issuer;
        this.#secret = secret;
        this.#timeout = timeout;
    }

    getToken() {
        const now = Date.now() / 1000;
        const payload = {
            iss: this.#issuer,
            jti: `${Math.random()}`,
            iat: now,
            exp: now + this.#timeout,
        }
        const token = jwtSimple.encode(payload, this.#secret);
        return 'JWT ' + token;
    }
}

/******************************************************************************/

export async function shellExec(text) {
    let command = '';
    let r;
    for ( const line of text.split(/[\n\r]+/) ) {
        command += line.trim();
        if ( command.endsWith(' \\') ) {
            command = command.slice(0, -1);
            continue;
        }
        command = command.trim();
        if ( command === '' ) { continue; }
        if ( commandLineArgs.verbose ) {
            console.log(`Executing: ${command}`);
        }
        r = execSync(command, { encoding: 'utf8' });
        command = '';
    }
    return r?.trim();
}

/******************************************************************************/

const cleanupJobs = [];

export function cleanupAdd(fn) {
    cleanupJobs.push(fn);
}

export async function cleanDo() {
    const promises = [];
    while ( cleanupJobs.length !== 0 ) {
        const fn = cleanupJobs.shift();
        try {
            promises.push(fn());
        } catch {
        }
    }
    await Promise.all(promises);
}

/******************************************************************************/

export async function getTempDir() {
    const tempDir = await fs.mkdtemp('/tmp/github-asset-');
    cleanupAdd(( ) => {
        console.log(`Removing ${tempDir}`);
        shellExec(`rm -rf "${tempDir}"`);
    });
    return tempDir;
}

/******************************************************************************/

// https://grahamwatts.co.uk/gnome-secrets/
// How to store a secret:
//   secret-tool store --label="[...]" token [name] 

export async function getSecret(token) {
    if ( secrets[token] === undefined ) {
        secrets[token] = await shellExec(`secret-tool lookup token ${token}`);
    }
    return secrets[token];
}

const secrets = {};

/******************************************************************************/

export function intFromVersion(version) {
    const matches = [ ...version.matchAll(/\d+/g) ];
    let versionInt = 0;
    for ( let i = 0; i < 4; i++ ) {
        const n = i < matches.length
            ? (parseInt(matches[i][0]) || 0)
            : 0;
        versionInt = versionInt * 1000 + n;
    }
    return versionInt;
}

/******************************************************************************/

export const commandLineArgs = (( ) => {
    const args = Object.create(null);
    let name, value;
    for ( const arg of process.argv.slice(2) ) {
        const pos = arg.indexOf('=');
        if ( pos === -1 ) {
            name = arg;
            value = true;
        } else {
            name = arg.slice(0, pos);
            value = arg.slice(pos+1);
        }
        args[name] = value;
    }
    return args;
})();
