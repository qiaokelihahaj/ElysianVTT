export function setNestedProperty(obj: object, path: string, value: unknown): void {
    const keys = path.split('.');
    let current = obj as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] === undefined || current[key] === null) {
            current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
    }
    
    current[keys[keys.length - 1]] = value;
}
