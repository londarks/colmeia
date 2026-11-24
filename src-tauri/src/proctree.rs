// Árvore de processos por terminal.
//
// No Windows, matar o processo do agente não derruba os filhos dele (node, bash,
// servidores de dev que o agente subiu). Cada sessão de PTY ganha um Job Object
// com KILL_ON_JOB_CLOSE: matar a sessão — ou o app fechar/crashar, o que fecha o
// handle — encerra a árvore inteira. Os netos herdam o job automaticamente.
// Em Unix é um no-op (o portable-pty já mata o grupo de processos).

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct ProcessTree {
        job: HANDLE,
    }

    // O handle do job só é usado para Terminate/Close, que são thread-safe.
    unsafe impl Send for ProcessTree {}
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        /// Coloca o processo `pid` (e tudo que ele criar depois) num job próprio.
        pub fn attach(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let ok = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(ProcessTree { job })
            }
        }

        /// Encerra a árvore inteira agora.
        pub fn kill(&self) {
            unsafe {
                TerminateJobObject(self.job, 1);
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE: fechar o último handle encerra o que sobrou.
            unsafe {
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct ProcessTree;

    impl ProcessTree {
        pub fn attach(_pid: u32) -> Option<Self> {
            None
        }
        pub fn kill(&self) {}
    }
}

pub use imp::ProcessTree;
