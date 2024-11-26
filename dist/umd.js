(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.ky = factory());
})(this, (function () { 'use strict';

    class HTTPError extends Error {
        response;
        request;
        options;
        constructor(response, request, options) {
            const code = (response.status || response.status === 0) ? response.status : '';
            const title = response.statusText || '';
            const status = `${code} ${title}`.trim();
            const reason = status ? `status code ${status}` : 'an unknown error';
            super(`Request failed with ${reason}: ${request.method} ${request.url}`);
            this.name = 'HTTPError';
            this.response = response;
            this.request = request;
            this.options = options;
        }
    }

    class TimeoutError extends Error {
        request;
        constructor(request) {
            super(`Request timed out: ${request.method} ${request.url}`);
            this.name = 'TimeoutError';
            this.request = request;
        }
    }

    const supportsRequestStreams = (() => {
        let duplexAccessed = false;
        let hasContentType = false;
        const supportsReadableStream = typeof globalThis.ReadableStream === 'function';
        const supportsRequest = typeof globalThis.Request === 'function';
        if (supportsReadableStream && supportsRequest) {
            try {
                hasContentType = new globalThis.Request('https://empty.invalid', {
                    body: new globalThis.ReadableStream(),
                    method: 'POST',
                    // @ts-expect-error - Types are outdated.
                    get duplex() {
                        duplexAccessed = true;
                        return 'half';
                    },
                }).headers.has('Content-Type');
            }
            catch (error) {
                // QQBrowser on iOS throws "unsupported BodyInit type" error (see issue #581)
                if (error instanceof Error && error.message === 'unsupported BodyInit type') {
                    return false;
                }
                throw error;
            }
        }
        return duplexAccessed && !hasContentType;
    })();
    const supportsAbortController = typeof globalThis.AbortController === 'function';
    const supportsResponseStreams = typeof globalThis.ReadableStream === 'function';
    const supportsFormData = typeof globalThis.FormData === 'function';
    const requestMethods = ['get', 'post', 'put', 'patch', 'head', 'delete'];
    const responseTypes = {
        json: 'application/json',
        text: 'text/*',
        formData: 'multipart/form-data',
        arrayBuffer: '*/*',
        blob: '*/*',
    };
    // The maximum value of a 32bit int (see issue #117)
    const maxSafeTimeout = 2_147_483_647;
    // Size in bytes of a typical form boundary, used to help estimate upload size
    const usualFormBoundarySize = new TextEncoder().encode('------WebKitFormBoundaryaxpyiPgbbPti10Rw').length;
    const stop = Symbol('stop');
    const kyOptionKeys = {
        json: true,
        parseJson: true,
        stringifyJson: true,
        searchParams: true,
        prefixUrl: true,
        retry: true,
        timeout: true,
        hooks: true,
        throwHttpErrors: true,
        onDownloadProgress: true,
        onUploadProgress: true,
        fetch: true,
    };
    const requestOptionsRegistry = {
        method: true,
        headers: true,
        body: true,
        mode: true,
        credentials: true,
        cache: true,
        redirect: true,
        referrer: true,
        referrerPolicy: true,
        integrity: true,
        keepalive: true,
        signal: true,
        window: true,
        dispatcher: true,
        duplex: true,
        priority: true,
    };

    // eslint-disable-next-line @typescript-eslint/ban-types
    const getBodySize = (body) => {
        if (!body) {
            return 0;
        }
        if (body instanceof FormData) {
            // This is an approximation, as FormData size calculation is not straightforward
            let size = 0;
            for (const [key, value] of body) {
                size += usualFormBoundarySize;
                size += new TextEncoder().encode(`Content-Disposition: form-data; name="${key}"`).length;
                size += typeof value === 'string'
                    ? new TextEncoder().encode(value).length
                    : value.size;
            }
            return size;
        }
        if (body instanceof Blob) {
            return body.size;
        }
        if (body instanceof ArrayBuffer) {
            return body.byteLength;
        }
        if (typeof body === 'string') {
            return new TextEncoder().encode(body).length;
        }
        if (body instanceof URLSearchParams) {
            return new TextEncoder().encode(body.toString()).length;
        }
        if ('byteLength' in body) {
            return (body).byteLength;
        }
        if (typeof body === 'object' && body !== null) {
            try {
                const jsonString = JSON.stringify(body);
                return new TextEncoder().encode(jsonString).length;
            }
            catch {
                return 0;
            }
        }
        return 0; // Default case, unable to determine size
    };
    const streamResponse = (response, onDownloadProgress) => {
        const totalBytes = Number(response.headers.get('content-length')) || 0;
        let transferredBytes = 0;
        if (response.status === 204) {
            if (onDownloadProgress) {
                onDownloadProgress({ percent: 1, totalBytes, transferredBytes }, new Uint8Array());
            }
            return new Response(null, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
        return new Response(new ReadableStream({
            async start(controller) {
                const reader = response.body.getReader();
                if (onDownloadProgress) {
                    onDownloadProgress({ percent: 0, transferredBytes: 0, totalBytes }, new Uint8Array());
                }
                async function read() {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    if (onDownloadProgress) {
                        transferredBytes += value.byteLength;
                        const percent = totalBytes === 0 ? 0 : transferredBytes / totalBytes;
                        onDownloadProgress({ percent, transferredBytes, totalBytes }, value);
                    }
                    controller.enqueue(value);
                    await read();
                }
                await read();
            },
        }), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
    const streamRequest = (request, onUploadProgress) => {
        const totalBytes = getBodySize(request.body);
        let transferredBytes = 0;
        return new Request(request, {
            // @ts-expect-error - Types are outdated.
            duplex: 'half',
            body: new ReadableStream({
                async start(controller) {
                    const reader = request.body instanceof ReadableStream ? request.body.getReader() : new Response('').body.getReader();
                    async function read() {
                        const { done, value } = await reader.read();
                        if (done) {
                            // Ensure 100% progress is reported when the upload is complete
                            if (onUploadProgress) {
                                onUploadProgress({ percent: 1, transferredBytes, totalBytes: Math.max(totalBytes, transferredBytes) }, new Uint8Array());
                            }
                            controller.close();
                            return;
                        }
                        transferredBytes += value.byteLength;
                        let percent = totalBytes === 0 ? 0 : transferredBytes / totalBytes;
                        if (totalBytes < transferredBytes || percent === 1) {
                            percent = 0.99;
                        }
                        if (onUploadProgress) {
                            onUploadProgress({ percent: Number(percent.toFixed(2)), transferredBytes, totalBytes }, value);
                        }
                        controller.enqueue(value);
                        await read();
                    }
                    await read();
                },
            }),
        });
    };

    // eslint-disable-next-line @typescript-eslint/ban-types
    const isObject = (value) => value !== null && typeof value === 'object';

    const validateAndMerge = (...sources) => {
        for (const source of sources) {
            if ((!isObject(source) || Array.isArray(source)) && source !== undefined) {
                throw new TypeError('The `options` argument must be an object');
            }
        }
        return deepMerge({}, ...sources);
    };
    const mergeHeaders = (source1 = {}, source2 = {}) => {
        const result = new globalThis.Headers(source1);
        const isHeadersInstance = source2 instanceof globalThis.Headers;
        const source = new globalThis.Headers(source2);
        for (const [key, value] of source.entries()) {
            if ((isHeadersInstance && value === 'undefined') || value === undefined) {
                result.delete(key);
            }
            else {
                result.set(key, value);
            }
        }
        return result;
    };
    function newHookValue(original, incoming, property) {
        return (Object.hasOwn(incoming, property) && incoming[property] === undefined)
            ? []
            : deepMerge(original[property] ?? [], incoming[property] ?? []);
    }
    const mergeHooks = (original = {}, incoming = {}) => ({
        beforeRequest: newHookValue(original, incoming, 'beforeRequest'),
        beforeRetry: newHookValue(original, incoming, 'beforeRetry'),
        afterResponse: newHookValue(original, incoming, 'afterResponse'),
        beforeError: newHookValue(original, incoming, 'beforeError'),
    });
    // TODO: Make this strongly-typed (no `any`).
    const deepMerge = (...sources) => {
        let returnValue = {};
        let headers = {};
        let hooks = {};
        for (const source of sources) {
            if (Array.isArray(source)) {
                if (!Array.isArray(returnValue)) {
                    returnValue = [];
                }
                returnValue = [...returnValue, ...source];
            }
            else if (isObject(source)) {
                for (let [key, value] of Object.entries(source)) {
                    if (isObject(value) && key in returnValue) {
                        value = deepMerge(returnValue[key], value);
                    }
                    returnValue = { ...returnValue, [key]: value };
                }
                if (isObject(source.hooks)) {
                    hooks = mergeHooks(hooks, source.hooks);
                    returnValue.hooks = hooks;
                }
                if (isObject(source.headers)) {
                    headers = mergeHeaders(headers, source.headers);
                    returnValue.headers = headers;
                }
            }
        }
        return returnValue;
    };

    const normalizeRequestMethod = (input) => requestMethods.includes(input) ? input.toUpperCase() : input;
    const retryMethods = ['get', 'put', 'head', 'delete', 'options', 'trace'];
    const retryStatusCodes = [408, 413, 429, 500, 502, 503, 504];
    const retryAfterStatusCodes = [413, 429, 503];
    const defaultRetryOptions = {
        limit: 2,
        methods: retryMethods,
        statusCodes: retryStatusCodes,
        afterStatusCodes: retryAfterStatusCodes,
        maxRetryAfter: Number.POSITIVE_INFINITY,
        backoffLimit: Number.POSITIVE_INFINITY,
        delay: attemptCount => 0.3 * (2 ** (attemptCount - 1)) * 1000,
    };
    const normalizeRetryOptions = (retry = {}) => {
        if (typeof retry === 'number') {
            return {
                ...defaultRetryOptions,
                limit: retry,
            };
        }
        if (retry.methods && !Array.isArray(retry.methods)) {
            throw new Error('retry.methods must be an array');
        }
        if (retry.statusCodes && !Array.isArray(retry.statusCodes)) {
            throw new Error('retry.statusCodes must be an array');
        }
        return {
            ...defaultRetryOptions,
            ...retry,
        };
    };

    // `Promise.race()` workaround (#91)
    async function timeout(request, init, abortController, options) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (abortController) {
                    abortController.abort();
                }
                reject(new TimeoutError(request));
            }, options.timeout);
            void options
                .fetch(request, init)
                .then(resolve)
                .catch(reject)
                .then(() => {
                clearTimeout(timeoutId);
            });
        });
    }

    // https://github.com/sindresorhus/delay/tree/ab98ae8dfcb38e1593286c94d934e70d14a4e111
    async function delay(ms, { signal }) {
        return new Promise((resolve, reject) => {
            if (signal) {
                signal.throwIfAborted();
                signal.addEventListener('abort', abortHandler, { once: true });
            }
            function abortHandler() {
                clearTimeout(timeoutId);
                reject(signal.reason);
            }
            const timeoutId = setTimeout(() => {
                signal?.removeEventListener('abort', abortHandler);
                resolve();
            }, ms);
        });
    }

    const findUnknownOptions = (request, options) => {
        const unknownOptions = {};
        for (const key in options) {
            if (!(key in requestOptionsRegistry) && !(key in kyOptionKeys) && !(key in request)) {
                unknownOptions[key] = options[key];
            }
        }
        return unknownOptions;
    };

    class Ky {
        static create(input, options) {
            const ky = new Ky(input, options);
            const function_ = async () => {
                if (typeof ky._options.timeout === 'number' && ky._options.timeout > maxSafeTimeout) {
                    throw new RangeError(`The \`timeout\` option cannot be greater than ${maxSafeTimeout}`);
                }
                // Delay the fetch so that body method shortcuts can set the Accept header
                await Promise.resolve();
                // Before using ky.request, _fetch clones it and saves the clone for future retries to use.
                // If retry is not needed, close the cloned request's ReadableStream for memory safety.
                let response = await ky._fetch();
                for (const hook of ky._options.hooks.afterResponse) {
                    // eslint-disable-next-line no-await-in-loop
                    const modifiedResponse = await hook(ky.request, ky._options, ky._decorateResponse(response.clone()));
                    if (modifiedResponse instanceof globalThis.Response) {
                        response = modifiedResponse;
                    }
                }
                ky._decorateResponse(response);
                if (!response.ok && ky._options.throwHttpErrors) {
                    let error = new HTTPError(response, ky.request, ky._options);
                    for (const hook of ky._options.hooks.beforeError) {
                        // eslint-disable-next-line no-await-in-loop
                        error = await hook(error);
                    }
                    throw error;
                }
                // If `onDownloadProgress` is passed, it uses the stream API internally
                if (ky._options.onDownloadProgress) {
                    if (typeof ky._options.onDownloadProgress !== 'function') {
                        throw new TypeError('The `onDownloadProgress` option must be a function');
                    }
                    if (!supportsResponseStreams) {
                        throw new Error('Streams are not supported in your environment. `ReadableStream` is missing.');
                    }
                    return streamResponse(response.clone(), ky._options.onDownloadProgress);
                }
                return response;
            };
            const isRetriableMethod = ky._options.retry.methods.includes(ky.request.method.toLowerCase());
            const result = (isRetriableMethod ? ky._retry(function_) : function_())
                .finally(async () => {
                // Now that we know a retry is not needed, close the ReadableStream of the cloned request.
                if (!ky.request.bodyUsed) {
                    await ky.request.body?.cancel();
                }
            });
            for (const [type, mimeType] of Object.entries(responseTypes)) {
                result[type] = async () => {
                    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                    ky.request.headers.set('accept', ky.request.headers.get('accept') || mimeType);
                    const response = await result;
                    if (type === 'json') {
                        if (response.status === 204) {
                            return '';
                        }
                        const arrayBuffer = await response.clone().arrayBuffer();
                        const responseSize = arrayBuffer.byteLength;
                        if (responseSize === 0) {
                            return '';
                        }
                        if (options.parseJson) {
                            return options.parseJson(await response.text());
                        }
                    }
                    return response[type]();
                };
            }
            return result;
        }
        request;
        abortController;
        _retryCount = 0;
        _input;
        _options;
        // eslint-disable-next-line complexity
        constructor(input, options = {}) {
            this._input = input;
            this._options = {
                ...options,
                headers: mergeHeaders(this._input.headers, options.headers),
                hooks: mergeHooks({
                    beforeRequest: [],
                    beforeRetry: [],
                    beforeError: [],
                    afterResponse: [],
                }, options.hooks),
                method: normalizeRequestMethod(options.method ?? this._input.method ?? 'GET'),
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                prefixUrl: String(options.prefixUrl || ''),
                retry: normalizeRetryOptions(options.retry),
                throwHttpErrors: options.throwHttpErrors !== false,
                timeout: options.timeout ?? 10_000,
                fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
            };
            if (typeof this._input !== 'string' && !(this._input instanceof URL || this._input instanceof globalThis.Request)) {
                throw new TypeError('`input` must be a string, URL, or Request');
            }
            if (this._options.prefixUrl && typeof this._input === 'string') {
                if (this._input.startsWith('/')) {
                    throw new Error('`input` must not begin with a slash when using `prefixUrl`');
                }
                if (!this._options.prefixUrl.endsWith('/')) {
                    this._options.prefixUrl += '/';
                }
                this._input = this._options.prefixUrl + this._input;
            }
            if (supportsAbortController) {
                const originalSignal = this._options.signal ?? this._input.signal;
                this.abortController = new globalThis.AbortController();
                this._options.signal = originalSignal ? AbortSignal.any([originalSignal, this.abortController.signal]) : this.abortController.signal;
            }
            if (supportsRequestStreams) {
                // @ts-expect-error - Types are outdated.
                this._options.duplex = 'half';
            }
            if (this._options.json !== undefined) {
                this._options.body = this._options.stringifyJson?.(this._options.json) ?? JSON.stringify(this._options.json);
                this._options.headers.set('content-type', this._options.headers.get('content-type') ?? 'application/json');
            }
            this.request = new globalThis.Request(this._input, this._options);
            if (this._options.searchParams) {
                // eslint-disable-next-line unicorn/prevent-abbreviations
                const textSearchParams = typeof this._options.searchParams === 'string'
                    ? this._options.searchParams.replace(/^\?/, '')
                    : new URLSearchParams(this._options.searchParams).toString();
                // eslint-disable-next-line unicorn/prevent-abbreviations
                const searchParams = '?' + textSearchParams;
                const url = this.request.url.replace(/(?:\?.*?)?(?=#|$)/, searchParams);
                // To provide correct form boundary, Content-Type header should be deleted each time when new Request instantiated from another one
                if (((supportsFormData && this._options.body instanceof globalThis.FormData)
                    || this._options.body instanceof URLSearchParams) && !(this._options.headers && this._options.headers['content-type'])) {
                    this.request.headers.delete('content-type');
                }
                // The spread of `this.request` is required as otherwise it misses the `duplex` option for some reason and throws.
                this.request = new globalThis.Request(new globalThis.Request(url, { ...this.request }), this._options);
            }
            // If `onUploadProgress` is passed, it uses the stream API internally
            if (this._options.onUploadProgress) {
                if (typeof this._options.onUploadProgress !== 'function') {
                    throw new TypeError('The `onUploadProgress` option must be a function');
                }
                if (!supportsRequestStreams) {
                    throw new Error('Request streams are not supported in your environment. The `duplex` option for `Request` is not available.');
                }
                const originalBody = this.request.body;
                if (originalBody) {
                    this.request = streamRequest(this.request, this._options.onUploadProgress);
                }
            }
        }
        _calculateRetryDelay(error) {
            this._retryCount++;
            if (this._retryCount > this._options.retry.limit || error instanceof TimeoutError) {
                throw error;
            }
            if (error instanceof HTTPError) {
                if (!this._options.retry.statusCodes.includes(error.response.status)) {
                    throw error;
                }
                const retryAfter = error.response.headers.get('Retry-After')
                    ?? error.response.headers.get('RateLimit-Reset')
                    ?? error.response.headers.get('X-RateLimit-Reset') // GitHub
                    ?? error.response.headers.get('X-Rate-Limit-Reset'); // Twitter
                if (retryAfter && this._options.retry.afterStatusCodes.includes(error.response.status)) {
                    let after = Number(retryAfter) * 1000;
                    if (Number.isNaN(after)) {
                        after = Date.parse(retryAfter) - Date.now();
                    }
                    else if (after >= Date.parse('2024-01-01')) {
                        // A large number is treated as a timestamp (fixed threshold protects against clock skew)
                        after -= Date.now();
                    }
                    const max = this._options.retry.maxRetryAfter ?? after;
                    return after < max ? after : max;
                }
                if (error.response.status === 413) {
                    throw error;
                }
            }
            const retryDelay = this._options.retry.delay(this._retryCount);
            return Math.min(this._options.retry.backoffLimit, retryDelay);
        }
        _decorateResponse(response) {
            if (this._options.parseJson) {
                response.json = async () => this._options.parseJson(await response.text());
            }
            return response;
        }
        async _retry(function_) {
            try {
                return await function_();
            }
            catch (error) {
                const ms = Math.min(this._calculateRetryDelay(error), maxSafeTimeout);
                if (this._retryCount < 1) {
                    throw error;
                }
                await delay(ms, { signal: this._options.signal });
                for (const hook of this._options.hooks.beforeRetry) {
                    // eslint-disable-next-line no-await-in-loop
                    const hookResult = await hook({
                        request: this.request,
                        options: this._options,
                        error: error,
                        retryCount: this._retryCount,
                    });
                    // If `stop` is returned from the hook, the retry process is stopped
                    if (hookResult === stop) {
                        return;
                    }
                }
                return this._retry(function_);
            }
        }
        async _fetch() {
            for (const hook of this._options.hooks.beforeRequest) {
                // eslint-disable-next-line no-await-in-loop
                const result = await hook(this.request, this._options);
                if (result instanceof Request) {
                    this.request = result;
                    break;
                }
                if (result instanceof Response) {
                    return result;
                }
            }
            const nonRequestOptions = findUnknownOptions(this.request, this._options);
            // Cloning is done here to prepare in advance for retries
            const mainRequest = this.request;
            this.request = mainRequest.clone();
            if (this._options.timeout === false) {
                return this._options.fetch(mainRequest, nonRequestOptions);
            }
            return timeout(mainRequest, nonRequestOptions, this.abortController, this._options);
        }
    }

    /*! MIT License © Sindre Sorhus */
    const createInstance = (defaults) => {
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        const ky = (input, options) => Ky.create(input, validateAndMerge(defaults, options));
        for (const method of requestMethods) {
            // eslint-disable-next-line @typescript-eslint/promise-function-async
            ky[method] = (input, options) => Ky.create(input, validateAndMerge(defaults, options, { method }));
        }
        ky.create = (newDefaults) => createInstance(validateAndMerge(newDefaults));
        ky.extend = (newDefaults) => {
            if (typeof newDefaults === 'function') {
                newDefaults = newDefaults(defaults ?? {});
            }
            return createInstance(validateAndMerge(defaults, newDefaults));
        };
        ky.stop = stop;
        return ky;
    };
    const ky = createInstance();

    return ky;

}));
