//! End-to-end tests for cloud-folder sync: two or three real databases
//! sharing one folder, with the real trigger pipeline and engine.
mod basics;
mod collections;
mod common;
mod conflict_resolve;
mod conflict_review;
mod conflict_silent;
mod folder;
mod identity;
mod issue_close;
mod library;
mod lifecycle;
mod locate_file;
mod metadata;
mod migration;
mod retry;
mod retry_ops;
mod service;
mod support;
mod waiting;
