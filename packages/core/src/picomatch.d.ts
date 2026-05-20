declare module "picomatch" {
  type Matcher = (input: string) => boolean;

  type Options = {
    dot?: boolean;
    noextglob?: boolean;
    strictBrackets?: boolean;
  };

  function picomatch(pattern: string, options?: Options): Matcher;
  function picomatch(patterns: string[], options?: Options): Matcher;

  namespace picomatch {
    function isMatch(input: string, pattern: string, options?: Options): boolean;
    function isMatch(input: string, patterns: string[], options?: Options): boolean;
  }

  export default picomatch;
}
