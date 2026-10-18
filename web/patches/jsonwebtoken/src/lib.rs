//! The one item of `jsonwebtoken` 9 that `bedrockrs_proto_core` uses: the
//! error type it wraps in its own error enum. Arnis reads and writes Bedrock
//! worlds and never touches the network protocol that signs tokens.

pub mod errors {
    use std::fmt;

    /// Never constructed; exists so `#[from] jsonwebtoken::errors::Error`
    /// keeps compiling.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Error(());

    impl fmt::Display for Error {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("JSON web tokens are not supported in this build")
        }
    }

    impl std::error::Error for Error {}

    pub type Result<T> = std::result::Result<T, Error>;
}
