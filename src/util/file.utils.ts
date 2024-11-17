import tiktoken from "tiktoken";

// Token counter
export  function countToken  (text: string): number {
    // This encoding is used in GPT-4
    const encoding = tiktoken.get_encoding("cl100k_base");
    const tokenCount = encoding.encode(text);


    return tokenCount?.length ?? 0;
};
