import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult
} from 'vscode-languageserver/node';

import { test_compile } from '../mipsy_vscode/pkg/mipsy_vscode';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';


const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    hasWorkspaceFolderCapability = !!capabilities?.workspace?.workspaceFolders;

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true
            }
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

interface MipsSettings {
    maxDiagonstics: number;
}

const defaultSettings: MipsSettings = {
    maxDiagonstics: 3
};
const documentSettings: Map<string, Thenable<MipsSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    console.log('change ' + JSON.stringify(change));
    if (hasConfigurationCapability) {
        documentSettings.clear();
    }

    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<MipsSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(defaultSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'mips'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    connection.console.log(`validating ${textDocument.uri}...`);

    const settings = await getDocumentSettings(textDocument.uri);
    const recheckAmt = settings?.maxDiagonstics || 3;

    const source = textDocument.getText();

    const diagnostics: Diagnostic[] = [];

    const response = test_compile(source, 'test.s', recheckAmt);

    let tabsSize = 8;
    const tabSizeAttributeMatch = /#!\[[ \t]*tabsize[ \t]*\([ \t]*(\d{1,2})[ \t]*\)[ \t]*\]/.exec(source);
    if (tabSizeAttributeMatch && tabSizeAttributeMatch[1]) {
        tabsSize = parseInt(tabSizeAttributeMatch[1]) || tabsSize;
    }

    function correctColumn(lineNum: number, column: number) {
        if (column === 0) {
            return column;
        }

        try {
            const lineStartOffset = textDocument.offsetAt({
                line: lineNum,
                character: 0
            });
            const lineRegExp = /(.*)$/gm;
            lineRegExp.lastIndex = lineStartOffset;
            const lineMatch = lineRegExp.exec(source);
            if (!lineMatch || !lineMatch.length) {
                return column;
            }

            const lineContents = lineMatch[1];

            let actualColumn = 0;
            let displayColumn = 0;
            for (let c of lineContents) {
                displayColumn += c === '\t' ? tabsSize : 1;
                actualColumn++;

                console.log(displayColumn, actualColumn);
                if (displayColumn === column) {
                    return actualColumn;
                }
            }

            return column;
        } catch {
            return column;
        }

    }

    for (let err of response.errors) {
        console.log(err);
        // just stick non localised errors at the start
        const lineNum = err.localised ? err.line - 1 : 0;
        // const lineNum = err.localised ? err.line - 1 : textDocument.lineCount - 1;

        let message = err.message;
        if (err.tips && err.tips.length) {
            if (err.tips.length === 1) {
                message += `\nTip from mipsy: ${err.tips[0]}`.trimEnd();
            } else {
                message += `\nTips from mipsy:\n${
                    err.tips.map((tip: string) => '* ' + tip + '\n')
                }`.trimEnd();
            }
        }

        if (!err.localised) {
            message += '\n[this error applies to the whole file]';
        }

        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: {
                    line: lineNum,
                    character: err.localised ? correctColumn(lineNum, err.col - 1) : 0,
                },
                end: {
                    line: lineNum,
                    character: err.localised ? correctColumn(lineNum, err.col_end - 1) : Number.MAX_VALUE,
                },
            },
            message: message.trim(),
            source: 'mipsy'
        };

        console.log(diagnostic);
        diagnostics.push(diagnostic);
    };
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
    connection.console.log('Received a file change event');
});

connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        return [];
    }
);


documents.listen(connection);

connection.listen();
connection.console.log('Listening!');
