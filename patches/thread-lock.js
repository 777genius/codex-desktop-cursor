const chains = new Map();

export function acquireThreadLock(threadKey) {
    if (!threadKey) {
        return Promise.resolve(() => { });
    }
    const prev = chains.get(threadKey) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    chains.set(threadKey, prev.then(() => held, () => held));
    return prev.catch(() => undefined).then(() => {
        console.log(`[lock] ${threadKey}`);
        let unlocked = false;
        return () => {
            if (unlocked)
                return;
            unlocked = true;
            release();
        };
    });
}
