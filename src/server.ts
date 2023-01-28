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
    Position,
    TextDocument
} from 'vscode-languageserver-textdocument';

import { suggestions as staticSuggestions }  from './lsp_data.json';


const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const splitSources: {[uri: string]: string[]} = {};

interface Definition {
    type: 'label' | 'constant',
    line: number,
    identifier: string
}

const cachedDefinitions: {[uri: string]: Definition[] | undefined} = {};


let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    // capabilities.textDocument?.completion?.completionItem.

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                triggerCharacters: ['$', '.'],
                completionItem: {
                    labelDetailsSupport: true
                },
                // resolveProvider: true
            }
        }
    };

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
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
    delete splitSources[e.document.uri];
    delete cachedDefinitions[e.document.uri];
    documentSettings.delete(e.document.uri);
});

documents.onDidChangeContent(change => {
    const source = change.document.getText();
    let splitter = source.indexOf('\r\n') === -1 ? '\n' : '\r\n';
    let lines = source.split(splitter).map(line => line.replace('\r', '').replace('\n', ''));

    delete cachedDefinitions[change.document.uri];
    splitSources[change.document.uri] = lines;

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
        // console.log(err);
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

        // console.log(diagnostic);
        diagnostics.push(diagnostic);
    };
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
    connection.console.log('Received a file change event');
});

function getDefinitions(uri: string): Definition[] {
    const cachedValue = cachedDefinitions[uri];
    if (cachedValue) {
        return cachedValue;
    }

    const lines = splitSources[uri] || [];
    const definitions: Definition[] = [];

    lines.forEach((line, lineNum) => {
        const trimmed = line.split('#')[0].trim();
        if (trimmed === '') {
            return;
        }

        let lineIter = line;

        while (true) {
            const match = /^[ \t]*([a-zA-Z_0-9.]+)[ \t]*:(.*)$/.exec(lineIter);
            if (match === null) {
                break;
            }
            definitions.push({
                identifier: match[1],
                line: lineNum,
                type: 'label'
            });
            lineIter = match[2];
        }

        while (true) {
            const match = /^[ \t]*([a-zA-Z_0-9.]+)[ \t]*=(.*)$/.exec(lineIter);
            if (match === null) {
                break;
            }
            definitions.push({
                identifier: match[1],
                line: lineNum,
                type: 'constant'
            });
            lineIter = match[2];
        }

    });

    return (cachedDefinitions[uri] = definitions);
}

connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const lineNum = textDocumentPosition.position.line;
    const colNum = textDocumentPosition.position.character;
    const uri = textDocumentPosition.textDocument.uri;
    const line = (splitSources[uri] || [])[lineNum] || '';
    const definitions = getDefinitions(uri);

    const before = line.slice(0, colNum);
    const after = line.slice(colNum);

    if (before.indexOf('#') !== -1) {
        // probably in comment - although the # might be in a string/character literal
        return [];
    }

    const beforeWord = (/\$?[a-zA-z.0-9]*$/.exec(before) || [''])[0] || '';
    const beforeWithLabelsRemoved = before.replace(/[A-Za-z_][A-Za-z_0-9.]*[ \t]*:/g, '');

    const isStartOfLine = /^[ \t]*$/.test(
        beforeWithLabelsRemoved.slice(0, beforeWithLabelsRemoved.length - beforeWord.length)
    );
    const isImmeadiateV0 = /^[ \t]*li[ \t]+\$v0[ \t]*,[ \t]*[0-9]{0,2}$/.test(beforeWithLabelsRemoved);

    const allSuggestions = Array.from(staticSuggestions);

    // console.log({before,after,beforeWord,beforeWithLabelsRemoved,isStartOfLine});

    definitions.forEach(definition => {
        allSuggestions.push({
            label: definition.identifier,
            type: definition.type,
        });
    });

    const result: CompletionItem[] = [];

    allSuggestions.forEach(suggestion => {
        if (!isStartOfLine && suggestion.type === 'instruction') {
            return;
        }

        if (!isStartOfLine && suggestion.type === 'directive') {
            return;
        }

        if (suggestion.type === 'syscall_num' && !isImmeadiateV0) {
            return;
        }

        let sortLevel = 'c';

        if (suggestion.type === 'register') {
            sortLevel = 'd';
        }

        if (suggestion.type === 'register' && beforeWord.startsWith('$') && !isStartOfLine) {
            sortLevel = 'a';
        }

        if (suggestion.type === 'directive' && beforeWord.startsWith('.') && isStartOfLine) {
            sortLevel = 'a';
        }

        if (suggestion.type === 'directive' && !isStartOfLine) {
            sortLevel = 'e';
        }

        if (suggestion.type === 'syscall_num') {
            sortLevel = `a${suggestion.syscall_common ? 'a' : 'b'}$`;
        }

        const item: CompletionItem = {
            label: suggestion.label,
            kind: CompletionItemKind.Function,
            filterText: suggestion.label,
            sortText: `${sortLevel}${suggestion.sort_data || ''}${suggestion.label}`,
            data: {}
        };

        if (suggestion.type === 'instruction') {
            item.kind = CompletionItemKind.Function;
        } else if (suggestion.type === 'constant') {
            item.kind = CompletionItemKind.Constant;
        } else if (suggestion.type === 'label') {
            item.kind = CompletionItemKind.Reference;
        } else if (suggestion.type === 'directive') {
            item.kind = CompletionItemKind.Keyword;
        } else if (suggestion.type === 'register') {
            item.kind = CompletionItemKind.Variable;
        } else if (suggestion.type === 'syscall_num') {
            item.kind = CompletionItemKind.Event;
        } else {
            console.log(`Don't know what kind for ${suggestion.type}`);
        }

        if (suggestion.docs && suggestion.docs !== 'todo') {
            item.labelDetails = {
                description: suggestion.docs
            };
            if (suggestion.type === 'syscall_num') {
                item.documentation = `syscall: ${suggestion.docs}`;
            } else {
                item.documentation = suggestion.docs;
            }
        }

        let matchingLength = 0;
        while (matchingLength < Math.min(beforeWord.length, suggestion.label.length)) {
            if (beforeWord[matchingLength] === suggestion.label[matchingLength]) {
                matchingLength++;
            } else {
                break;
            }
        }

        const appendTab = isStartOfLine && suggestion.autoIndent;

        if (!/[a-zA-Z]/.test(suggestion.label[0])) {
            const editPosition: Position = {
                line: lineNum,
                character: colNum
            };
            item.textEdit = {
                newText: suggestion.label.slice(matchingLength) + (appendTab ? '\t' : ''),
                range: {
                    start: {
                        line: lineNum,
                        character: colNum - (beforeWord.length - matchingLength)
                    },
                    end: editPosition
                },
            };
        } else {
            item.insertText = suggestion.label + (appendTab ? '\t' : '');
        }

        result.push(item);
    });

    // return [{label:"Text",kind:CompletionItemKind.Text},{label:"Method",kind:CompletionItemKind.Method},{label:"Function",kind:CompletionItemKind.Function},{label:"Constructor",kind:CompletionItemKind.Constructor},{label:"Field",kind:CompletionItemKind.Field},{label:"Variable",kind:CompletionItemKind.Variable},{label:"Class",kind:CompletionItemKind.Class},{label:"Interface",kind:CompletionItemKind.Interface},{label:"Module",kind:CompletionItemKind.Module},{label:"Property",kind:CompletionItemKind.Property},{label:"Unit",kind:CompletionItemKind.Unit},{label:"Value",kind:CompletionItemKind.Value},{label:"Enum",kind:CompletionItemKind.Enum},{label:"Keyword",kind:CompletionItemKind.Keyword},{label:"Snippet",kind:CompletionItemKind.Snippet},{label:"Color",kind:CompletionItemKind.Color},{label:"File",kind:CompletionItemKind.File},{label:"Reference",kind:CompletionItemKind.Reference},{label:"Folder",kind:CompletionItemKind.Folder},{label:"EnumMember",kind:CompletionItemKind.EnumMember},{label:"Constant",kind:CompletionItemKind.Constant},{label:"Struct",kind:CompletionItemKind.Struct},{label:"Event",kind:CompletionItemKind.Event},{label:"Operator",kind:CompletionItemKind.Operator},{label:"TypeParameter",kind:CompletionItemKind.TypeParameter}];

    return result;
});


documents.listen(connection);

connection.listen();
connection.console.log('Listening!');
