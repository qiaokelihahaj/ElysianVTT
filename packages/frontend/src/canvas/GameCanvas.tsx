import React, { useEffect, useRef } from 'react';
import { RendererManager } from './RendererManager';

interface GameCanvasProps {
    width?: number;
    height?: number;
}

export const GameCanvas: React.FC<GameCanvasProps> = ({
    width = window.innerWidth,
    height = window.innerHeight,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!canvasRef.current) return;

        const manager = RendererManager.getInstance();

        const initPixi = async () => {
            await manager.initialize({
                canvas: canvasRef.current!,
                width,
                height,
            });
        };

        // Delay init to allow React mounting
        initPixi();

        return () => {
            // Cleanup on unmount
            manager.destroy();
        };
    }, [width, height]);

    return (
        <canvas
            ref={canvasRef}
            style={{ display: 'block', width: '100%', height: '100%' }}
        />
    );
};
