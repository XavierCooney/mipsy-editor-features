import {
    LoggingDebugSession, OutputEvent, LoadedSourceEvent,
    InitializedEvent, StoppedEvent, TerminatedEvent, InvalidatedEvent, ContinuedEvent
} from '@vscode/debugadapter';
import {
    DebugProtocol
} from '@vscode/debugprotocol';
import { make_new_runtime, DebugRuntime } from '../mipsy_vscode/pkg/mipsy_vscode';
const { promises: fs } = require("fs");

// const rand = Math.floor(Math.random() * 9000) + 1000;

const THREAD_ID = 1;
const STEPS_PER_INTERVAL = 250;

class MipsRuntime {
    private readonly runtime: DebugRuntime;
    private autoRunning: boolean;

    constructor(readonly source: string, readonly filename: string, readonly path: string, readonly session: MipsSession) {
        this.runtime = make_new_runtime(
            source, filename
        );
        this.autoRunning = false;

        // literally the jankiest part of this whole thing
        setInterval(() => {
            for (let i = 0; i < STEPS_PER_INTERVAL && this.autoRunning; ++i) {
                if (!this.step()) {
                    this.setAutorun(false, 'breakpoint');
                }
            }

            // this.session.sendEvent(new StoppedEvent('step'));
            // this.session.sendEvent(new ContinuedEvent(THREAD_ID));
        }, 50);
    }

    setAutorun(auto: boolean, adapterReason: string) {
        if (this.autoRunning && !auto) {
            this.session.sendEvent(new StoppedEvent(adapterReason, THREAD_ID));
            this.session.sendDebugLine('stoppped because ' + adapterReason);
        }
        this.autoRunning = auto;
    }

    step(): boolean {
        const result = this.runtime.step_debug();

        if (result === 'StepSuccess') {
             return true;
        } else if (result === 'AtSyscallGuard') {
            const syscallGuard = this.runtime.get_syscall_type();

            if (syscallGuard === 'print') {
                const printResult = this.runtime.do_print();

                if (printResult.length) {
                    this.session.sendStdoutLine(printResult);
                }

                return true;
            } else if (syscallGuard === 'exit') {
                this.session.sendStdoutLine('exiting...');
                this.session.sendEvent(new TerminatedEvent());
                this.runtime.remove_runtime();
                return true;
            } else if (syscallGuard === 'breakpoint') {
                this.runtime.acknowledge_breakpoint();
                this.session.sendDebugLine('breakpoint!');
                return false;
            } else {
                this.session.sendDebugLine('syscall ' + syscallGuard);
                return false;
            }
        } else if (result === 'NoRuntime') {
            this.setAutorun(false, 'step');
            return false;
        } else if (typeof result === 'object' && result['StepError']) {
            const err = result['StepError'];
            this.session.sendDebugLine('error: ' + err);
            this.setAutorun(false, 'step');
            return false;
        }

        this.session.sendDebugLine('result ' + JSON.stringify(result));
        return false;
    }

    setBreakpoints(lines: number[]) {
        return Array.from(this.runtime.set_breakpoints_from_lines(
            new Uint32Array(lines)
        ));
    }

    getLineNum(): number | undefined {
        return this.runtime.get_line_num();
    }

    readRegisters() {
        const arrayData = Array.from(this.runtime.dump_registers());

        const writeMarker = arrayData[32];

        const generalPurposeRegisterNames = [
            'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
            't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
            't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'
        ];

        const result: {
            name: string, value: number
        }[] = [];

        generalPurposeRegisterNames.forEach((reg, idx) => {
            if (writeMarker & (1 << idx)) {
                result.push({
                    name: '$' + reg,
                    value: arrayData[idx]
                });
            }
        });

        return result;
    }

    getPC() {
        const arrayData = Array.from(this.runtime.dump_registers());
        return arrayData[arrayData.length - 1];
    }
}

// TODO: this is structured incredibly badly
class MipsSession extends LoggingDebugSession {
    private sourceFilePath: string = '';
    private source: string = '';
    private sourceName: string = '<source code>';
    private initialBreakpoints: number[] = [];

    private runtime: MipsRuntime | undefined;

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};

        response.body.supportsStepBack = true;
        response.body.supportsConfigurationDoneRequest = true;

        response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsInstructionBreakpoints = true;

        response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

        response.body.supportTerminateDebuggee = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    sendDebugLine(str: string) {
        this.sendEvent(new OutputEvent(`[debug] ${str}\n`, 'debug console'));
    }

    sendStdoutLine(str: string) {
        this.sendEvent(new OutputEvent(`${str}\n`, 'stdout'));
    }

    sendError(str: string) {
        // oh no!
        this.sendEvent(new OutputEvent(`${str}\n`, 'important'));
    }

    getSource() {
        return {
            name: this.sourceName,
            path: this.sourceFilePath,
            sourceReference: 0
        };
    }

    sendSource() {
        // no idea if this is necessary
        this.sendEvent(new LoadedSourceEvent(
            'new', this.getSource()
        ));
    }

    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request) {
        response.body = {
            content: this.source,
        };
        this.sendResponse(response);
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request | undefined): Promise<void> {
        // this.sendDebugLine('opening');
        this.sendResponse(response);

        // TODO: this is vscode specific, i have no idea how to get the path for other clients
        const fsPath = (args as any)?.program?.fsPath;

        if (!fsPath) {
            return this.sendError('no path :(');
        }

        this.sourceFilePath = fsPath;

        try {
            const source = await fs.readFile(fsPath, 'utf8');
            this.source = source;
        } catch {
            this.sendError(`can't read the file :[`);
            this.sendEvent(new TerminatedEvent());
        }

        // this.sendDebugLine(`wow ${this.source}`);
        const pathParts = fsPath.split(/[\/\\]/);
        this.sourceName = pathParts[pathParts.length - 1];

        try {
            this.runtime = new MipsRuntime(this.source, this.sourceName, this.sourceFilePath, this);
        } catch (e) {
            this.sendError('Error:\n' + e);
            this.sendEvent(new TerminatedEvent());
        }

        this.runtime?.setBreakpoints(this.initialBreakpoints);

        // this.sendSource();

        this.sendEvent(new StoppedEvent(
            'entry',
            THREAD_ID
        ));
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        response.body = {
            threads: [{
                id: 1,
                name: 'thread name'
            }]
        };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
        this.runtime?.setAutorun(false, 'pause');
        this.sendEvent(new StoppedEvent('pause', THREAD_ID));
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request | undefined): void {
        this.sendResponse(response);
        this.runtime?.setAutorun(true, 'continue');
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request | undefined): void {
        if (!this.runtime) {
            return;
        }

        const oldLine = this.runtime.getLineNum();
        while (this.runtime.step()) {
            const newLine = this.runtime.getLineNum();
            // this.sendDebugLine(`old ${oldLine}, new ${newLine}, pc ${this.runtime.getPC()}`);
            if (newLine !== oldLine && newLine !== undefined) {
                break;
            }
        }

        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', THREAD_ID));
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void {
        response.body = {
            totalFrames: 1,
            stackFrames: [{
                id: 1,
                name: '',
                line: this.runtime?.getLineNum() || 0,
                column: 1,
                source: this.getSource()
            }]
        };
        this.sendResponse(response);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request | undefined): void {
        this.sendDebugLine(JSON.stringify(args));

        const breakpoints = args.breakpoints || [];

        let breakpointLines = breakpoints.map(
            breakpoint => breakpoint.line
        );

        let linesWithActualBreakpoints: number[] = [];

        if (this.runtime) {
            linesWithActualBreakpoints = this.runtime.setBreakpoints(breakpointLines);
        } else {
            this.initialBreakpoints = breakpointLines;
            linesWithActualBreakpoints = breakpointLines; // guess that they're all valid
        }

        response.body = {
            breakpoints: breakpoints.map(b => ({
                verified: linesWithActualBreakpoints.includes(b.line)
            }))
        };
        this.sendDebugLine(JSON.stringify(response));

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            scopes: [{
                name: 'Registers',
                presentationHint: 'registers',
                variablesReference: 7,
                expensive: false,
                source: this.getSource()
            }]
        };

        this.sendResponse(response);
    }

    protected renderRegisterValue(value: number) {
        // so this is probably not good, but as a heuristic, display small values (-1024 < x < 1024)
        // as two's complement decimal, and larger ones as unsigned hexadecimal, since they're more
        // likely to be addresses/bit fields/whatever
        if (-1024 < value && value < 1024) {
            return value.toString();
        } else {
            if (value < 0) {
                value += (1 << 30) * 4;
            }
            return '0x' + value.toString(16).padStart(8, '0');
        }
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            variables: []
        };

        if (this.runtime) {
            const registers = this.runtime.readRegisters();
            for (let register of registers) {
                response.body.variables.push({
                    name: register.name,
                    value: this.renderRegisterValue(register.value),
                    presentationHint: {
                        kind: 'data',
                        attributes: ['readOnly']
                    },
                    variablesReference: 0,
                });
            }
        }

        this.sendResponse(response);
    }

    public sendEvent(event: DebugProtocol.Event): void {
        if (event.event !== 'output') {
            // this.sendDebugLine(`event ${JSON.stringify(event)}`);
        }
        return super.sendEvent(event);
    }

    protected dispatchRequest(request: DebugProtocol.Request) {
        // this.sendDebugLine(`request ${JSON.stringify(request)}`);
        return super.dispatchRequest(request);
    }

    sendResponse(response: DebugProtocol.Response): void {
        // this.sendDebugLine(`response ${JSON.stringify(response)}`);
        return super.sendResponse(response);
    }
}

const session = new MipsSession("out-file.txt");
session.start(process.stdin, process.stdout);
