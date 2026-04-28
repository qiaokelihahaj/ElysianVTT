import { TickEvent } from '@hard-vtt/shared';

export class PriorityQueue {
    private heap: TickEvent[] = [];

    // 获取当前队列事件数量
    public get size(): number {
        return this.heap.length;
    }

    // 压入新事件
    public push(event: TickEvent): void {
        this.heap.push(event);
        this._siftUp(this.heap.length - 1);
    }

    // 弹出最早发生的事件
    public pop(): TickEvent | undefined {
        if (this.heap.length === 0) return undefined;
        if (this.heap.length === 1) return this.heap.pop();

        const top = this.heap[0];
        this.heap[0] = this.heap.pop() as TickEvent;
        this._siftDown(0);
        return top;
    }

    // 查看最早的事件但不弹出
    public peek(): TickEvent | undefined {
        return this.heap.length > 0 ? this.heap[0] : undefined;
    }

    // --- 内部：堆调整算法 ---
    private _siftUp(index: number): void {
        let currentIndex = index;
        while (currentIndex > 0) {
            const parentIndex = Math.floor((currentIndex - 1) / 2);
            if (this.heap[currentIndex].targetTick >= this.heap[parentIndex].targetTick) {
                break;
            }
            this._swap(currentIndex, parentIndex);
            currentIndex = parentIndex;
        }
    }

    private _siftDown(index: number): void {
        let currentIndex = index;
        const length = this.heap.length;

        while (true) {
            const leftChild = 2 * currentIndex + 1;
            const rightChild = 2 * currentIndex + 2;
            let smallest = currentIndex;

            if (leftChild < length && this.heap[leftChild].targetTick < this.heap[smallest].targetTick) {
                smallest = leftChild;
            }
            if (rightChild < length && this.heap[rightChild].targetTick < this.heap[smallest].targetTick) {
                smallest = rightChild;
            }
            if (smallest === currentIndex) break;

            this._swap(currentIndex, smallest);
            currentIndex = smallest;
        }
    }

    private _swap(i: number, j: number): void {
        const temp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = temp;
    }
}