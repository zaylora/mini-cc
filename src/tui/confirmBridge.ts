export interface ConfirmRequest {
  message: string;
  respond: (allowed: boolean) => void;
}

export interface ConfirmBridge {
  confirm: (message: string) => Promise<boolean>;
  subscribe: (listener: (request: ConfirmRequest) => void) => void;
}

export function createConfirmBridge(): ConfirmBridge {
  let listener: ((request: ConfirmRequest) => void) | undefined;

  return {
    confirm(message) {
      return new Promise<boolean>((resolve) => {
        if (!listener) {
          resolve(false);
          return;
        }
        listener({ message, respond: resolve });
      });
    },
    subscribe(fn) {
      listener = fn;
    },
  };
}
