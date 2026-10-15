terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "5.25.0" }
  }
}
provider "cloudflare" {}
variable "account_id" { type = string }
variable "environment" {
  type = string
  validation {
    condition = contains(["staging", "production"], var.environment)
    error_message = "Choose staging or production explicitly."
  }
}
locals { name = "job-stack-${var.environment}" }
resource "cloudflare_d1_database" "records" {
  account_id = var.account_id
  name = local.name
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.account_id
  name = local.name
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = local.name
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_queue" "dead_letters" {
  account_id = var.account_id
  queue_name = "${local.name}-dlq"
  lifecycle { prevent_destroy = true }
}
output "database_id" { value = cloudflare_d1_database.records.id }
output "bucket_name" { value = cloudflare_r2_bucket.artifacts.name }
output "queue_name" { value = cloudflare_queue.jobs.queue_name }
output "account_id" { value = var.account_id }
output "environment" { value = var.environment }
