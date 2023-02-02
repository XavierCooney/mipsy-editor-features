import * as vscode from 'vscode';

import { setupDecompilationButton } from './decompileView';
import { setupIOView } from './ioViewProvider';
import { setupDebugButton, setupSendInputButton } from './launchDebug';
import { deactivateClient, startLSP } from './lspClient';
import { setupMemoryButton } from './memoryViewer';


export function activate(context: vscode.ExtensionContext) {
    console.log('Starting! How exciting!');

    startLSP(context);
    setupDecompilationButton(context);
    setupDebugButton(context);
    setupMemoryButton(context);
    setupIOView(context);
    setupSendInputButton(context);
}

export function deactivate() {
    deactivateClient();
}
