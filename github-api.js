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
import { commandLineArgs, fetchEx } from './utils.js';
import { getSecret, getTempDir, intFromVersion, shellExec } from './utils.js';
import path from 'node:path';

/******************************************************************************/

const githubAuth = `Bearer ${await getSecret('github_token')}`;
const githubOwner = commandLineArgs.ghowner;
const githubRepo = commandLineArgs.ghrepo;
const githubTag = commandLineArgs.ghtag;
const githubAsset = commandLineArgs.ghasset;

export const details = {
    auth: githubAuth,
    owner: githubOwner,
    repo: githubRepo,
    tag: githubTag,
    asset: githubAsset,
};

/******************************************************************************/

function validateGithubToken() {
    if ( githubAuth === '' ) {
        throw new Error('Need GitHub token');
    }
}

function validateGithubVars() {
    validateGithubToken();
    if ( githubOwner === '' ) {
        throw new Error('Need GitHub owner');
    }
    if ( githubRepo === '' ) {
        throw new Error('Need GitHub repo');
    }
    if ( githubTag === '' ) {
        throw new Error('Need GitHub tag');
    }
    if ( githubAsset === '' ) {
        throw new Error('Need GitHub asset name');
    }
}

/******************************************************************************/

export async function getReleaseInfo() {
    validateGithubVars();
    console.log(`Fetching release info for ${githubOwner}/${githubRepo}/${githubTag} from GitHub`);
    const releaseInfoUrl =  `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/tags/${githubTag}`;
    const request = new Request(releaseInfoUrl, {
        headers: {
            Authorization: githubAuth,
        },
    });
    const { response, data } = await fetchEx(request, 'json');
    if ( response === undefined ) { return; }
    if ( data === undefined ) { return; }
    return data;
}

/******************************************************************************/

export async function getLatestReleaseInfo() {
    validateGithubVars();
    console.log(`Fetching latest release info for ${githubOwner}/${githubRepo} from GitHub`);
    const releaseInfoUrl =  `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;
    const request = new Request(releaseInfoUrl, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: githubAuth,
        },
    });
    const { data } = await fetchEx(request, 'json');
    return data;
}

/******************************************************************************/

export async function getAssetInfo() {
    const releaseInfo = await getReleaseInfo();
    if ( releaseInfo === undefined ) { return; }
    if ( releaseInfo.assets === undefined ) { return; }
    for ( const asset of releaseInfo.assets ) {
        if ( asset.name.includes(githubAsset) ) { return asset; }
    }
}

/******************************************************************************/

export async function downloadAssetFromRelease(assetInfo) {
    validateGithubToken();
    const assetURL = assetInfo.url;
    console.log(`Fetching ${assetURL}`);
    const request = new Request(assetURL, {
        headers: {
            Authorization: githubAuth,
            Accept: 'application/octet-stream',
        },
    });
    const { response, data } = await fetchEx(request, 'bytes');
    if ( response === undefined ) { return; }
    if ( data === undefined ) { return; }
    const tempDir = await getTempDir();
    const fileName = `${tempDir}/${assetInfo.name}`;
    await fs.writeFile(fileName, data);
    return fileName;
}

/******************************************************************************/

export async function uploadAssetToRelease(assetPath, mimeType) {
    validateGithubToken();
    console.log(`Uploading "${assetPath}" to GitHub...`);
    const data = await fs.readFile(assetPath).catch(( ) => { });
    if ( data === undefined ) { return; }
    const releaseInfo = await getReleaseInfo();
    if ( releaseInfo.upload_url === undefined ) { return; }
    const assetName = path.basename(assetPath);
    const uploadURL = releaseInfo.upload_url.replace('{?name,label}', `?name=${assetName}`);
    console.log('Upload URL:', uploadURL);
    const request = new Request(uploadURL, {
        body: new Int8Array(data.buffer, data.byteOffset, data.length),
        headers: {
            Authorization: githubAuth,
            'Content-Type': mimeType,
        },
        method: 'POST',
    });
    const { response, data: json } = await fetchEx(request, 'json');
    if ( response === undefined ) { return; }
    return json;
}

/******************************************************************************/

export async function deleteAssetFromRelease(assetURL) {
    validateGithubToken();
    console.log(`Remove ${assetURL} from GitHub release ${githubTag}...`);
    const request = new Request(assetURL, {
        headers: {
            Authorization: githubAuth,
        },
        method: 'DELETE',
    });
    const { response } = await fetchEx(request);
    return response?.ok;
}

/******************************************************************************/

export async function updateFirefoxAutoUpdateFile(updateFilePath, details) {
    validateGithubVars();
    const { amoExtensionId, manifest, signedPackageName } = details;
    if ( amoExtensionId === undefined ) {
        console.log(`amoExtensionId = ${amoExtensionId}`);
        return;
    }
    if ( manifest === undefined ) {
        console.log(`manifest = ${manifest}`);
        return;
    }
    if ( signedPackageName === undefined ) {
        console.log(`signedPackageName = ${signedPackageName}`);
        return;
    }
    let r = await shellExec(`git diff --staged`);
    if ( r ) {
        console.log(`git diff --staged = ${r}`);
        return;
    }
    const text = await fs.readFile(updateFilePath, {
        encoding: 'utf8'
    }).catch(reason => {
        console.log(`${reason}`);
    });
    if ( text === undefined ) {
        console.log(`fs.readFile = ${text}`);
        return;
    }
    const data = JSON.parse(text);
    const update = data.addons[amoExtensionId].updates[0];
    if ( intFromVersion(manifest.version) < intFromVersion(update.version) ) {
        console.log(`New version older than current version: ${update.version} < ${manifest.version}`);
        return;
    }
    update.version = manifest.version;
    update.update_link = `https://github.com/${githubOwner}/${githubRepo}/releases/download/${githubTag}/${signedPackageName}`;
    await fs.writeFile(updateFilePath, JSON.stringify(data, null, 2));
    await shellExec(`git add -u "${updateFilePath}"`);
    r = await shellExec(`git status -s "${updateFilePath}"`);
    if ( Boolean(r) === false ) {
        console.log(`git status -s "${updateFilePath}" = ${r}`);
        return;
    }
    shellExec(`
        git commit -m 'Make Firefox dev build auto-update' "${updateFilePath}"
        git push origin HEAD
    `, { stdio: 'inherit' });
    return true;
}
