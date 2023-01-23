use std::rc::Rc;
use serde::{Serialize, Deserialize};
use mipsy_parser::TaggedFile;
use wasm_bindgen::prelude::*;
use mipsy_lib::{compile::{CompilerOptions}, MipsyError, InstSet, Binary, runtime::SteppedRuntime};
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

fn compile_form_source(source: &str, filename: &str, reason: &str, iset: &InstSet) -> Result<Binary, String> {
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

    compile_form_source(source, filename, "dissassembled", iset).map(
        |binary| mipsy_lib::decompile(iset, &binary)
    ).unwrap_or_else(|msg| msg)
}

#[wasm_bindgen]
pub struct DebugRuntime {
    mipsy_runtime: Option<SteppedRuntime>,
    binary: Binary,
    latest_pc: Option<u32>
}

#[derive(Serialize, Deserialize)]
pub enum StepResult {
    AtSyscallGuard, StepSuccess, NoRuntime, StepError(String)
}

#[wasm_bindgen]
impl DebugRuntime {
    #[wasm_bindgen]
    pub fn step_debug(&mut self) -> Result<JsValue, JsValue> {
        let step_result = match self.mipsy_runtime.take() {
            Some(Ok(runtime)) => {
                match runtime.step() {
                    Ok(new_stepped_runtime) => {
                        if let Ok(new_runtime) = &new_stepped_runtime {
                            self.latest_pc = Some(new_runtime.timeline().state().pc());
                        }
                        self.mipsy_runtime = Some(new_stepped_runtime);

                        StepResult::StepSuccess
                    }
                    Err((new_runtime, _mipsy_error)) => {
                        self.latest_pc = Some(new_runtime.timeline().state().pc());
                        self.mipsy_runtime = Some(Ok(new_runtime));

                        StepResult::StepError(":(".into())
                    }
                }
            }
            Some(Err(guard)) => {
                self.mipsy_runtime = Some(Err(guard));
                StepResult::AtSyscallGuard
            }
            None => StepResult::NoRuntime
        };

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
                ReadInt(_) => "read",
                ReadFloat(_) => "read",
                ReadDouble(_) => "read",
                ReadChar(_) => "read",
                ReadString(_, _) => "read",
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
                _ => "".into()
            }
            None => "".into()
        };
        self.update_latest_pc();

        print_result
    }

    fn update_latest_pc(&mut self) {
        if let Some(Ok(runtime)) = &self.mipsy_runtime {
            self.latest_pc = Some(runtime.timeline().state().pc());
        }
    }

    pub fn get_line_num(&self) -> Option<u32> {
        self.latest_pc.filter(|&pc| pc <= mipsy_lib::compile::TEXT_TOP).and_then(
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

    pub fn remove_runtime(&mut self) {
        self.mipsy_runtime = None
    }
}

#[wasm_bindgen]
pub fn make_new_runtime(source: &str, filename: &str) -> Result<DebugRuntime, String> {
    let iset = &mipsy_instructions::inst_set();

    compile_form_source(source, filename, "run", iset).map(
        |binary| DebugRuntime {
            binary: binary.to_owned(),
            mipsy_runtime: Some(Ok(mipsy_lib::runtime(&binary, &[]))),
            latest_pc: None
        }
    )
}
