import * as vscode from 'vscode';

import { setupDecompilationButton } from './decompileView';
import { setupDebugButton } from './launchDebug';
import { deactivateClient, startLSP } from './lspClient';
import { setupMemoryButton } from './memoryViewer';


export function activate(context: vscode.ExtensionContext) {
    console.log('Starting! How exciting!');

    startLSP(context);
    setupDecompilationButton(context);
    setupDebugButton(context);
    setupMemoryButton(context);

    // context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    //     createDebugAdapterTracker(session: vscode.DebugSession) {
    //         return {
    //             onWillReceiveMessage: m => console.log(`> ${JSON.stringify(m, undefined, 2)}`),
    //             onDidSendMessage: m => console.log(`< ${JSON.stringify(m, undefined, 2)}`)
    //         };
    //     }
    // }));
}

export function deactivate() {
    deactivateClient();
}
