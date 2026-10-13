import net from 'node:net';
import { NativeFrameDecoder, encodeNativeFrame } from './native-wire.mjs';

// Connect only to the pre-created Windows broker pipe; never create a Node pipe with a default DACL.
export function attachNativeChannel({ pipe, service, onFailure = () => {}, connect = () => net.createConnection(pipe) }) {
  if (process.platform !== 'win32' || typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\quota-resume-')) {
    throw Error('Explicit Windows native broker pipe required');
  }
  const socket = connect();
  let failed = false, closed = false;
  const fail = () => {
    if (failed || closed) return;
    failed = true;
    socket.destroy();
    onFailure();
  };
  const decoder = new NativeFrameDecoder(message => {
    Promise.resolve(service.dispatch(message, reply => {
      if (!socket.destroyed) socket.write(encodeNativeFrame(reply));
    })).catch(fail);
  });
  socket.on('data', chunk => { try { decoder.push(chunk); } catch { fail(); } });
  socket.on('end', () => { try { decoder.end(); } catch { /* Report a truncated frame without disturbing host stdio. */ } fail(); });
  socket.on('error', fail);
  socket.on('close', fail);
  return { socket, close: () => { closed = true; socket.destroy(); } };
}
