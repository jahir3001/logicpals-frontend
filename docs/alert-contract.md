


approved alert types

approved severities

source table / source function

trigger condition

who should receive it

Example:

alert_type	          severity	     source	             trigger
boundary_violation	  critical	audit_events	          any cross-track attempt
ai_provider_failover	  critical	circuit breaker	          5 provider failures
ai_latency_high		  warning	platform health monitor	  p95 > threshold
daily_cost_exceeded	  warning	cost monitor	          daily spend > threshold