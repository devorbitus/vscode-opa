'use strict';

import cp = require('child_process');
const commandExistsSync = require('command-exists').sync;
import * as vscode from 'vscode';

import { promptForInstall } from './install-opa';
import { getImports, getPackage } from './util';
import { existsSync } from 'fs';

var regoVarPattern = new RegExp('^[a-zA-Z_][a-zA-Z0-9_]*$');

export function getDataDir(uri: vscode.Uri): string {
    // NOTE(tsandall): we don't have a precise version for 3be55ed6 so
    // do our best and rely on the -dev tag.
    if (!installedOPASameOrNewerThan("0.14.0-dev")) {
        return uri.fsPath;
    }
    return uri.toString();
}

export function canUseBundleFlags(): boolean {
    return installedOPASameOrNewerThan("0.14.0-dev");
}

export function dataParam(): string {
    if (canUseBundleFlags()) {
        return "--bundle";
    }
    return "--data";
}

// returns true if installed OPA is same or newer than OPA version x.
function installedOPASameOrNewerThan(x: string): boolean {
    const s = getOPAVersionString();
    return opaVersionSameOrNewerThan(s, x);
}

// returns true if OPA version a is same or newer than OPA version b. If either
// version is not in the expected format (i.e.,
// <major>.<minor>.<point>[-<patch>]) this function returns true. Major, minor,
// and point versions are compared numerically. Patch versions are compared
// lexigraphically however an empty patch version is considered newer than a
// non-empty patch version.
function opaVersionSameOrNewerThan(a: string, b: string): boolean {

    const aVersion = parseOPAVersion(a);
    const bVersion = parseOPAVersion(b);

    if (aVersion.length !== 4 || bVersion.length !== 4) {
        return true;
    }

    for (let i = 0; i < 3; i++) {
        if (aVersion[i] > bVersion[i]) {
            return true;
        } else if (bVersion[i] > aVersion[i]) {
            return false;
        }
    }

    if (aVersion[3] === '' && bVersion[3] !== '') {
        return true;
    } else if (aVersion[3] !== '' && bVersion[3] === '') {
        return false;
    }

    return aVersion[3] >= bVersion[3];
}

// returns array of numbers and strings representing an OPA semantic version.
function parseOPAVersion(s: string): any[] {


    const parts = s.split('.', 3);
    if (parts.length < 3) {
        return [];
    }

    const major = Number(parts[0]);
    const minor = Number(parts[1]);
    const pointParts = parts[2].split('-', 2);
    const point = Number(pointParts[0]);
    let patch = '';

    if (pointParts.length >= 2) {
        patch = pointParts[1];
    }

    return [major, minor, point, patch];
}

// returns the installed OPA version as a string.
function getOPAVersionString(): string {

    const result = cp.spawnSync('opa', ['version']);
    if (result.status !== 0) {
        return '';
    }

    const lines = result.stdout.toString().split('\n');

    for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].trim().split(': ', 2);
        if (parts.length < 2) {
            continue;
        }
        if (parts[0] === 'Version') {
            return parts[1];
        }
    }
    return '';
}

// refToString formats a ref as a string. Strings are special-cased for
// dot-style lookup. Note: this function is currently only used for populating
// picklists based on dependencies. As such it doesn't handle all term types
// properly.
export function refToString(ref: any[]): string {
    let result = ref[0].value;
    for (let i = 1; i < ref.length; i++) {
        if (ref[i].type === "string") {
            if (regoVarPattern.test(ref[i].value)) {
                result += '.' + ref[i].value;
                continue;
            }
        }
        result += '[' + JSON.stringify(ref[i].value) + ']';
    }
    return result;
}

/**
 * Helpers for executing OPA as a subprocess.
 */

export function parse(opaPath: string, path: string, cb: (pkg: string, imports: string[]) => void, onerror: (output: string) => void) {
    run(opaPath, ['parse', path, '--format', 'json'], '', (error: string, result: any) => {
        if (error !== '') {
            onerror(error);
        } else {
            let pkg = getPackage(result);
            let imports = getImports(result);
            cb(pkg, imports);
        }
    });
}

// run executes the OPA binary at path with args and stdin.  The callback is
// invoked with an error message on failure or JSON object on success.
export function run(path: string, args: string[], stdin: string, cb: (error: string, result: any) => void) {
    runWithStatus(path, args, stdin, (code: number, stderr: string, stdout: string) => {
        if (code !== 0) {
            if (stdout !== '') {
                cb(stdout, '');
            } else {
                cb(stderr, '');
            }
        } else {
            cb('', JSON.parse(stdout));
        }
    });
}

// runWithStatus executes the OPA binary at path with args and stdin. The
// callback is invoked with the exit status, stderr, and stdout buffers.
export function runWithStatus(path: string, args: string[], stdin: string, cb: (code: number, stderr: string, stdout: string) => void) {
    const opaPath = vscode.workspace.getConfiguration('opa').get<string>('path');
    const existsOnPath = commandExistsSync(path);
    const existsInUserSettings = opaPath !== undefined && opaPath !== null && existsSync(opaPath);

    if (!(existsOnPath || existsInUserSettings)) {
        promptForInstall();
        return;
    }

    if (existsInUserSettings && opaPath !== undefined) {
        // Prefer OPA in User Settings to the one installed on $PATH
        path = opaPath;
    }

    console.log("spawn:", path, "args:", args.toString());

    let proc = cp.spawn(path, args);

    proc.stdin.write(stdin);
    proc.stdin.end();
    let stdout = "";
    let stderr = "";

    proc.stdout.on('data', (data) => {
        stdout += data;
    });

    proc.stderr.on('data', (data) => {
        stderr += data;
    });

    proc.on('exit', (code, signal) => {
        console.log("code:", code);
        console.log("stdout:", stdout);
        console.log("stderr:", stderr);
        cb(code, stderr, stdout);
    });

}