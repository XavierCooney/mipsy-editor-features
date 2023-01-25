use std::{rc::Rc, collections::HashSet, str::FromStr, fmt::{Display}};
use serde::{Serialize, Deserialize};
use mipsy_parser::TaggedFile;
use wasm_bindgen::prelude::*;
use mipsy_lib::{compile::{CompilerOptions}, MipsyError, InstSet, Binary, runtime::{SteppedRuntime, RuntimeSyscallGuard}, Runtime, error::runtime::ErrorContext};
use mipsy_utils::{MipsyConfig};


// i have no idea if i need to keep this alloc thingy
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;


#[derive(Serialize, Deserialize, Clone)]
pub struct ErrorReport {
    message: String,
    localised: bool,
    tips: Vec<String>,
    file_tag: Rc<str>,
    line: u32,
    col: u32,
    col_end: u32,
}

#[derive(Serialize, Deserialize)]
pub struct ValidationResult {
    errors: Vec<ErrorReport>
}

fn check_source(iset: &InstSet, filename: &str, source: &str, compiler_options: &CompilerOptions, config: &MipsyConfig) -> Option<ErrorReport> {
    match mipsy_lib::compile(
        &iset, vec![TaggedFile::new(Some(&filename), source)],
        &compiler_options, &config
    ) {
        Ok(_) => None,
        Err(err) => match err {
            MipsyError::Parser(parse_err) => Some(ErrorReport {
                message: String::from("Parse failure: check your syntax!"), // is there actually no further info?
                localised: true,
                file_tag: parse_err.file_tag(),
                line: parse_err.line(),
                col: parse_err.col(),
                col_end: parse_err.col(),
                tips: vec![]
            }),
            MipsyError::Compiler(compile_err) => Some(ErrorReport {
                message: compile_err.error().message(),
                localised: compile_err.error().should_highlight_line(),
                file_tag: compile_err.file_tag(),
                line: compile_err.line(),
                col: compile_err.col(),
                col_end: compile_err.col_end(),
                tips: compile_err.error().tips()
            }),
            MipsyError::Runtime(_) => None, // should be unreachable?
        }
    }
}

#[wasm_bindgen]
pub fn test_compile(source: &str, filename: &str, max_problems: usize) -> Result<JsValue, JsValue>  {
    let compiler_options = &CompilerOptions::new(vec![]);
    let config = &MipsyConfig::default();
    let iset = &mipsy_instructions::inst_set();

    let mut all_errors: Vec<ErrorReport> = vec![];
    let mut error_lines: Vec<u32> = vec![];

    while all_errors.len() < max_problems {
        let err = check_source(
            iset, filename,
            &source
                .lines()
                .enumerate()
                .map(|(i, line)| {
                    if error_lines.contains(&u32::try_from(i).unwrap()) {
                        "".into()
                    } else {
                        line.into()
                    }
                })
                .collect::<Vec<&str>>().join("\n"),
            compiler_options, config
        );

        match err {
            None => break,
            Some(err) => {
                if error_lines.iter().any(|line| err.line <= *line) {
                    // error occured before a previously received error - probably spurious
                    break;
                }

                all_errors.push(err.clone());
                if !err.localised {
                    break;
                }

                error_lines.push(err.line - 1);
            },
        }
    }

    Ok(serde_wasm_bindgen::to_value(&ValidationResult {
        errors: all_errors
    })?)
}

fn compile_from_source(source: &str, filename: &str, reason: &str, iset: &InstSet) -> Result<Binary, String> {
    let compiler_options = &CompilerOptions::new(vec![]);
    let config = &MipsyConfig::default();

    match mipsy_lib::compile(
        &iset, vec![TaggedFile::new(Some(&filename), source)],
        &compiler_options, &config
    ) {
        Ok(binary) => Ok(binary),
        Err(_) => match check_source(iset, filename, source, compiler_options, config) {
            Some(err) => Err(std::format!(
                "Your MIPS program has an error so can't be {}: {}{}",
                reason,
                if err.localised {
                    std::format!("line {}: ", err.line)
                } else {
                    "".into()
                },
                err.message
            )),
            None => {
                Err("Hmm you've got a rather mysterious compiler error.".into())
            }
        }
    }
}

#[wasm_bindgen]
pub fn decompile_source(source: &str, filename: &str) -> String {
    let iset = &mipsy_instructions::inst_set();

    compile_from_source(source, filename, "dissassembled", iset).map(
        |binary| mipsy_lib::decompile(iset, &binary)
    ).unwrap_or_else(|msg| msg)
}

struct RegisterCache {
    registers: [i32; 32],
    write_marks: u32,
    hi: Option<i32>,
    lo: Option<i32>,
    pc: Option<u32>
}

#[wasm_bindgen]
pub struct DebugRuntime {
    mipsy_runtime: Option<SteppedRuntime>,
    binary: Binary,
    breakpoint_addrs: HashSet<u32>,
    registers: RegisterCache,
    iset: InstSet,
    sources: Vec<(Rc<str>, Rc<str>)>
}

#[derive(Serialize, Deserialize)]
pub enum StepResult {
    AtSyscallGuard, StepSuccess, NoRuntime, StepError(String)
}

#[wasm_bindgen]
impl DebugRuntime {
    pub fn step_debug(&mut self) -> Result<JsValue, JsValue> {
        let step_result = match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                match runtime.step() {
                    Ok(new_stepped_runtime) => {
                        self.mipsy_runtime = Some(new_stepped_runtime);
                        self.update_cached_registers();

                        StepResult::StepSuccess
                    }
                    Err((old_runtime, mipsy_error)) => {
                        // StepResult::StepError(":(".into())
                        let msg = StepResult::StepError(match mipsy_error {
                            MipsyError::Parser(_) | MipsyError::Compiler(_) =>
                                "A parser/compiler error?!".into(),
                            MipsyError::Runtime(err) => {
                                err.error().message(
                                    ErrorContext::Binary,
                                    &self.sources,
                                    &self.iset,
                                    &self.binary,
                                    &old_runtime
                                )
                            },
                        });

                        self.mipsy_runtime = Some(Ok(old_runtime));
                        self.update_cached_registers();

                        msg
                    }
                }
            }
            Some(Err(guard)) => {
                self.mipsy_runtime = Some(Err(guard));
                StepResult::AtSyscallGuard
            }
            None => StepResult::NoRuntime
        };

        self.check_for_breakpoint();

        Ok(serde_wasm_bindgen::to_value(&step_result)?)
    }

    pub fn decompile(&self) -> String {
        let iset = &mipsy_instructions::inst_set();

        mipsy_lib::decompile(iset, &self.binary)
    }

    pub fn get_syscall_type(&self) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;
        match &self.mipsy_runtime {
            Some(Ok(_)) => "none",
            Some(Err(guard)) => match guard {
                PrintInt(_, _) => "print",
                PrintFloat(_, _) => "print",
                PrintDouble(_, _) => "print",
                PrintString(_, _) => "print",
                PrintChar(_, _) => "print",
                ReadInt(_) => "read_int",
                ReadFloat(_) => "read_float",
                ReadDouble(_) => "read_double",
                ReadChar(_) => "read_character",
                ReadString(_, _) => "read_string",
                Sbrk(_, _) => "sbrk",
                Exit(_) => "exit",
                Open(_, _) => "open",
                Read(_, _) => "read",
                Write(_, _) => "write",
                Close(_, _) => "close",
                ExitStatus(_, _) => "exit",
                Breakpoint(_) => "breakpoint",
                Trap(_) => "trap",
            }
            None => "none"
        }.into()
    }

    pub fn do_print(&mut self) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;

        let print_result = match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
                "".into()
            }
            Some(Err(guard)) => match guard {
                PrintInt(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_int: {}",  args.value)
                },
                PrintFloat(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_float: {}",  args.value)
                },
                PrintDouble(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_double: {}",  args.value)
                },
                PrintString(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_string: {}",  String::from_utf8_lossy(&args.value))
                },
                PrintChar(args, new_runtime) => {
                    self.mipsy_runtime = Some(Ok(new_runtime));
                    std::format!("print_char: {}",  args.value as char)
                },
                guard => {
                    self.mipsy_runtime = Some(Err(guard));
                    "".into()
                }
            }
            None => "".into()
        };

        self.update_cached_registers();
        self.check_for_breakpoint();

        print_result
    }

    pub fn provide_input(&mut self, input: String) -> String {
        use mipsy_lib::runtime::RuntimeSyscallGuard::*;

        let mut user_message: String = "".into();

        // rust is awesome
        fn parse_input<T>(guard: Box<dyn FnOnce(T) -> Runtime>, variant: fn(Box<dyn FnOnce(T) -> Runtime>) -> RuntimeSyscallGuard, input: &str) -> (Option<SteppedRuntime>, String)
        where
            T: FromStr + Display,
            <T as FromStr>::Err: Display,
        {
            match input.parse() {
                Ok(value) => (Some(Ok(guard(value))), "ok".into()),
                Err(err) => {
                    (
                        Some(Err(variant(guard))),
                        std::format!("invalid input: {}", err.to_string())
                    )
                }
            }
        }

        match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
            }
            Some(Err(guard)) => match guard {
                ReadInt(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadInt, input.trim()
                    );
                },
                ReadFloat(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadFloat, input.trim()
                    );
                },
                ReadDouble(guard) => {
                    (self.mipsy_runtime, user_message) = parse_input(
                        guard, ReadDouble, input.trim()
                    );
                },
                ReadChar(guard) => {
                    let bytes = input.as_bytes();
                    let maybe_char = if bytes.len() == 1 { bytes.first() } else { None };
                    (self.mipsy_runtime, user_message) = if let Some(char) = maybe_char {
                        (Some(Ok(guard(*char))), "ok".into())
                    } else {
                        (Some(Err(ReadChar(guard))), if bytes.len() == 0 {
                            "invalid input: no character provided!"
                        } else {
                            "invalid input: too many characters provided!" // or non-ascii
                        }.into())
                    }
                },
                ReadString(args, guard) => {
                    let bytes = input.into_bytes();
                    (self.mipsy_runtime, user_message) = if bytes.len() > args.max_len as usize {
                        (Some(Ok(guard(bytes))), "ok".into())
                    } else {
                        (Some(Err(ReadString(args, guard))), "invalid input: string too long!".into())
                    }
                }
                guard => {
                    self.mipsy_runtime = Some(Err(guard));
                }
            }
            None => ()
        };

        self.update_cached_registers();
        self.check_for_breakpoint();

        user_message
    }

    pub fn acknowledge_breakpoint(&mut self) {
        match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                self.mipsy_runtime = Some(Ok(runtime));
            },
            Some(Err(guard)) => match guard {
                mipsy_lib::runtime::RuntimeSyscallGuard::Breakpoint(runtime) => {
                    self.mipsy_runtime = Some(Ok(runtime));
                    self.update_cached_registers();
                },
                guard => {
                    self.mipsy_runtime = Some(Err(guard))
                }
            },
            None => ()
        }
    }

    pub fn check_for_breakpoint(&mut self) {
        if let Some(Ok(runtime)) = &self.mipsy_runtime {
            if self.breakpoint_addrs.contains(&runtime.timeline().state().pc()) {
                self.mipsy_runtime = Some(Err(mipsy_lib::runtime::RuntimeSyscallGuard::Breakpoint(
                    self.mipsy_runtime.take().unwrap().ok().unwrap() // ughh
                )))
            }
        }
    }

    fn update_cached_registers(&mut self) {
        if let Some(Ok(runtime)) = &self.mipsy_runtime {
            let state = runtime.timeline().state();
            self.registers.pc = Some(state.pc());
            self.registers.write_marks = 0;
            for i in 0..32 {
                if let mipsy_lib::Safe::Valid(val) = state.registers()[i] {
                    self.registers.registers[i] = val;
                    self.registers.write_marks |= 1 << i;
                }
            }
            self.registers.hi = state.read_hi().ok();
            self.registers.lo = state.read_hi().ok();
        }
    }

    pub fn dump_registers(&self) -> Vec<i32> {
        let mut vec: Vec<i32> = Vec::with_capacity(38);

        vec.extend_from_slice(self.registers.registers.as_slice());
        vec.push(self.registers.write_marks as i32);
        vec.push(self.registers.hi.unwrap_or(0));
        vec.push(self.registers.lo.unwrap_or(0));
        vec.push(self.registers.hi.is_some().into());
        vec.push(self.registers.lo.is_some().into());
        vec.push(self.registers.pc.unwrap_or(0) as i32);

        vec
    }

    pub fn get_line_num(&self) -> Option<u32> {
        self.registers.pc.filter(|&pc| pc <= mipsy_lib::compile::TEXT_TOP).and_then(
            |pc| self.binary.line_numbers.get(&pc).or_else(|| {
                // from get_line_info in runtime_handler.rs
                let mut lines = self.binary.line_numbers
                    .iter()
                    .filter(|&(&addr, _)| addr <= pc)
                    .collect::<Vec<_>>();
                lines.sort_unstable_by_key(|&(&addr, _)| addr);
                lines.last().map(|&(_, pair)| pair)
            })
        ).map(
            |(_, line)| line.clone()
        )
    }

    pub fn step_back(&mut self, stop_on_breakpoint: bool) -> bool {
        let mut runtime = match self.mipsy_runtime.take() {
            None => return false,
            Some(Ok(runtime)) => runtime,
            Some(Err(guard)) => match guard {
                // we might be at a syscall guard - but in order to
                // access previous states we need a Runtime. so to
                // get a Runtime we pretend to actually run the syscall,
                // so that we can then rewind time
                RuntimeSyscallGuard::PrintInt(_, r) =>r,
                RuntimeSyscallGuard::PrintFloat(_, r) => r,
                RuntimeSyscallGuard::PrintDouble(_, r) => r,
                RuntimeSyscallGuard::PrintString(_, r) => r,
                RuntimeSyscallGuard::PrintChar(_, r) => r,
                RuntimeSyscallGuard::ReadInt(r) => r(0),
                RuntimeSyscallGuard::ReadFloat(r) => r(0f32),
                RuntimeSyscallGuard::ReadDouble(r) => r(0f64),
                RuntimeSyscallGuard::ReadChar(r) => r(0),
                RuntimeSyscallGuard::ReadString(_, r) => r(vec![]),
                RuntimeSyscallGuard::Sbrk(_, r) => r,
                RuntimeSyscallGuard::Exit(r) => r,
                RuntimeSyscallGuard::Open(_, r) => r(0),
                RuntimeSyscallGuard::Read(_, r) => r((0, vec![])),
                RuntimeSyscallGuard::Write(_, r) => r(0),
                RuntimeSyscallGuard::Close(_, r) => r(0),
                RuntimeSyscallGuard::ExitStatus(_, r) => r,
                RuntimeSyscallGuard::Breakpoint(r) => r,
                RuntimeSyscallGuard::Trap(r) => r,
            }
        };

        let success = runtime.timeline_mut().pop_last_state();
        self.mipsy_runtime = Some(Ok(runtime));

        self.update_cached_registers();

        let hit_breakpoint = stop_on_breakpoint && self.breakpoint_addrs.contains(&self.registers.pc.unwrap_or(0));

        return success && !hit_breakpoint;
    }

    pub fn remove_runtime(&mut self) {
        self.mipsy_runtime = None;
    }

    pub fn set_breakpoints_from_lines(&mut self, breakpoint_lines: Vec<u32>) -> Vec<u32> {
        if breakpoint_lines.is_empty() {
            self.breakpoint_addrs.clear();
            return vec![];
        }

        let memory_locations = self.binary.line_numbers.iter().filter(
            |(_, (_, line))| breakpoint_lines.contains(line)
        ).collect::<Vec<_>>();

        self.breakpoint_addrs = memory_locations.iter().map(|(&addr, _)| addr).collect();

        memory_locations.iter().map(
            |(_, &(_, line))| line
        ).collect()
    }
}

#[wasm_bindgen]
pub fn make_new_runtime(source: &str, filename: &str) -> Result<DebugRuntime, String> {
    let iset = mipsy_instructions::inst_set();

    compile_from_source(source, filename, "run", &iset).map(
        |binary| DebugRuntime {
            binary: binary.to_owned(),
            mipsy_runtime: Some(Ok(mipsy_lib::runtime(&binary, &[]))),
            breakpoint_addrs: HashSet::new(),
            registers: RegisterCache {
                registers: [0; 32],
                write_marks: 0,
                hi: None,
                lo: None,
                pc: None,
            },
            iset: iset,
            sources: vec![(filename.into(), source.into())]
        }
    )
}
