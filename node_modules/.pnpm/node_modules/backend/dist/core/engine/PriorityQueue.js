"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriorityQueue = void 0;
class PriorityQueue {
    heap = [];
    // 获取当前队列事件数量
    get size() {
        return this.heap.length;
    }
    // 压入新事件
    push(event) {
        this.heap.push(event);
        this._siftUp(this.heap.length - 1);
    }
    // 弹出最早发生的事件
    pop() {
        if (this.heap.length === 0)
            return undefined;
        if (this.heap.length === 1)
            return this.heap.pop();
        const top = this.heap[0];
        this.heap[0] = this.heap.pop();
        this._siftDown(0);
        return top;
    }
    // 查看最早的事件但不弹出
    peek() {
        return this.heap.length > 0 ? this.heap[0] : undefined;
    }
    // --- 内部：堆调整算法 ---
    _siftUp(index) {
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
    _siftDown(index) {
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
            if (smallest === currentIndex)
                break;
            this._swap(currentIndex, smallest);
            currentIndex = smallest;
        }
    }
    _swap(i, j) {
        const temp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = temp;
    }
}
exports.PriorityQueue = PriorityQueue;
//# sourceMappingURL=PriorityQueue.js.map