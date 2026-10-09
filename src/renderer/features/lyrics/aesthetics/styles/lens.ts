/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
export interface LensOptions {
    /** Chromatic aberration toward the rim. */
    aberration: number;
    /** Height of that fade; 0 disables it. */
    fadeSpan?: number;
    /** Fade everything above this height (share of screen from the top), e.g. under a clock. */
    fadeTop?: number;
    /** Draw the glass itself (black backdrop, rim shading, specular glint). Off over the desktop. */
    opaque: boolean;
    /** Lens radius as a share of the screen height. */
    radius: number;
    /** Centre magnification amount: 0 = flat glass, 0.42 ≈ 1.7× at the centre. */
    strength: number;
}

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_strength;
uniform float u_radius;
uniform float u_aberration;
uniform float u_opaque;
uniform float u_fadeTop;
uniform float u_fadeSpan;
varying vec2 v_uv;

// Convex dome: sample closer to the centre where the glass is thickest (magnify),
// and approach 1:1 at the rim so there is no seam where the glass ends.
vec2 refract(vec2 uv, float strength) {
  vec2 aspect = vec2(u_res.x / u_res.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  float r = length(p) / u_radius;
  if (r >= 1.0) return uv;
  float dome = sqrt(1.0 - r * r);
  float m = mix(1.0, 1.0 - strength, pow(dome, 1.4));
  return 0.5 + (p * m) / aspect;
}

void main() {
  vec2 aspect = vec2(u_res.x / u_res.y, 1.0);
  vec2 p = (v_uv - 0.5) * aspect;
  float r = length(p) / u_radius;
  float fringe = u_aberration * min(r, 1.0);
  vec4 cr = texture2D(u_tex, refract(v_uv, u_strength + fringe));
  vec4 cg = texture2D(u_tex, refract(v_uv, u_strength));
  vec4 cb = texture2D(u_tex, refract(v_uv, u_strength - fringe));
  vec4 color = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));

  if (u_opaque > 0.5) {
    color.rgb *= mix(1.0, 0.5, smoothstep(0.72, 1.0, r));
    vec2 g = (p / u_radius - vec2(-0.34, 0.4)) * vec2(1.0, 2.2);
    float glint = exp(-dot(g, g) * 30.0) * 0.05 * step(r, 1.0);
    color = vec4(color.rgb + glint, 1.0);
  }
  if (u_fadeSpan > 0.0) {
    // Premultiplied alpha: scaling the whole colour fades toward whatever is behind.
    color *= smoothstep(u_fadeTop, u_fadeTop + u_fadeSpan, 1.0 - v_uv.y);
  }
  gl_FragColor = color;
}`;

/** Draws a source canvas through a convex glass lens with WebGL. `ok` is false when WebGL is unavailable. */
export class LensRenderer {
    get maxDimension(): number {
        return this.limit;
    }
    get ok(): boolean {
        return this.gl !== null && !this.lost;
    }
    private buffer: null | WebGLBuffer = null;
    private gl: null | WebGLRenderingContext = null;
    private limit = 4096;
    private lost = false;
    private program: null | WebGLProgram = null;
    private texture: null | WebGLTexture = null;

    private uniforms: Record<string, null | WebGLUniformLocation> = {};

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly invalidate: () => void,
    ) {
        const gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
        });
        if (!gl) return;
        this.gl = gl;
        const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
        try {
            if (!vs || !fs) throw Error('Lens shaders unavailable');
            const program = gl.createProgram();
            this.program = program;
            if (!program) throw Error('Lens program unavailable');
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                throw Error('Lens program failed to link');
            gl.useProgram(program);
            const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
            this.limit = Math.max(
                1,
                Math.min(
                    4096,
                    gl.getParameter(gl.MAX_TEXTURE_SIZE),
                    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
                    viewport[0],
                    viewport[1],
                ),
            );
            this.buffer = gl.createBuffer();
            this.texture = gl.createTexture();
            if (!this.buffer || !this.texture) throw Error('Lens resources unavailable');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]),
                gl.STATIC_DRAW,
            );
            const pos = gl.getAttribLocation(program, 'a_pos');
            if (pos < 0) throw Error('Lens vertex attribute unavailable');
            gl.enableVertexAttribArray(pos);
            gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            for (const name of [
                'u_tex',
                'u_res',
                'u_strength',
                'u_radius',
                'u_aberration',
                'u_opaque',
                'u_fadeTop',
                'u_fadeSpan',
            ]) {
                this.uniforms[name] = gl.getUniformLocation(program, name);
            }
            gl.uniform1i(this.uniforms.u_tex!, 0);
            canvas.addEventListener('webglcontextlost', this.onContextLost);
        } catch {
            // The owning style displays its existing 2D source if GPU setup fails.
            this.dispose();
        } finally {
            if (vs) gl.deleteShader(vs);
            if (fs) gl.deleteShader(fs);
        }
    }
    dispose(): void {
        this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
        const gl = this.gl;
        if (gl) {
            if (this.texture) gl.deleteTexture(this.texture);
            if (this.buffer) gl.deleteBuffer(this.buffer);
            if (this.program) gl.deleteProgram(this.program);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
        this.gl = null;
        this.texture = null;
        this.buffer = null;
        this.program = null;
        this.uniforms = {};
    }

    draw(source: HTMLCanvasElement, opts: LensOptions, upload: boolean): void {
        const gl = this.gl;
        if (!gl || this.lost) return;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        if (upload) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.uniform2f(this.uniforms.u_res!, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uniforms.u_strength!, opts.strength);
        gl.uniform1f(this.uniforms.u_radius!, opts.radius);
        gl.uniform1f(this.uniforms.u_aberration!, opts.aberration);
        gl.uniform1f(this.uniforms.u_opaque!, opts.opaque ? 1 : 0);
        gl.uniform1f(this.uniforms.u_fadeTop!, opts.fadeTop ?? 0);
        gl.uniform1f(this.uniforms.u_fadeSpan!, opts.fadeSpan ?? 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    resize(width: number, height: number): void {
        this.canvas.width = Math.max(1, Math.min(this.limit, width));
        this.canvas.height = Math.max(1, Math.min(this.limit, height));
        this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    private readonly onContextLost = (event: Event): void => {
        event.preventDefault();
        this.lost = true;
        this.invalidate();
    };
}

function compile(gl: WebGLRenderingContext, type: number, source: string): null | WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('lens shader:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}
