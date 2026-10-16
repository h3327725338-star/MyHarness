// A Windows Job keeps even detached grandchildren owned by this desktop instance.
const koffi = require('koffi');
const kernel = koffi.load('kernel32.dll');
const create = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, str16 name)');
const set = kernel.func('bool __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32 length)');
const assign = kernel.func('bool __stdcall AssignProcessToJobObject(void *job, void *process)');
const open = kernel.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const close = kernel.func('bool __stdcall CloseHandle(void *handle)');
const lastError = kernel.func('uint32 __stdcall GetLastError()');
exports.createJob = () => {
  const handle = create(null, null);
  if (!handle) throw new Error(`CreateJobObjectW: ${lastError()}`);
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Windows x64: LimitFlags offset 16.
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!set(handle, 9, limits, limits.length)) {
    const code = lastError(); close(handle); throw new Error(`SetInformationJobObject: ${code}`);
  }
  return {
    assign(pid) {
      const process = open(0x0101, false, pid); // SET_QUOTA | TERMINATE
      if (!process) throw new Error(`OpenProcess: ${lastError()}`);
      try { if (!assign(handle, process)) throw new Error(`AssignProcessToJobObject: ${lastError()}`); }
      finally { close(process); }
    },
    close() { close(handle); },
  };
};
